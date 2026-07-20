import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "../supabase/test-users";
import type { ReviewRegenerationCommit } from "./review-regeneration";
import {
  buildPricingEvidenceSnapshotInput,
  createSupabasePricingEvidenceReader,
  pricingEvidenceSnapshotInputSchema,
} from "../pricing-evidence";
import {
  createSupabaseGuidedCorrectionCompletionGateway,
  GUIDED_CORRECTION_CAPABILITY_TTL_MS,
  type GuidedCorrectionCompletionRpcClient,
} from "./guided-correction-completion";
import {
  createSupabasePipelineWorkerStore,
  type PipelineAttemptAcquisition,
  type PipelineWorkerRpcClient,
} from "../pipeline-queue/worker-store";
import type { PipelineResult } from "./types";
import { canonicalizeVerifiedPhotoSet } from "../photo-identity/photo-set";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let reachable = false;
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;
const queueMessageIds = new Set<string>();
const originalRunIds = new Map<string, string>();

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: ANON_KEY },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function seedReview(user: ClerkTestUser, label: string) {
  const batchId = crypto.randomUUID();
  const idempotencyKey = `review-${batchId}`;
  const staged = await admin.rpc("stage_pipeline_batch", {
    p_batch_id: batchId,
    p_daily_limit: 1_000,
    p_entries: [{
      idempotency_key: idempotencyKey,
      source: "single",
      autopilot_enabled: false,
      photo_paths: [`${user.id}/review/${batchId}/front.jpg`],
      cost_basis: null,
    }],
    p_per_minute_limit: 1_000,
    p_photo_identities: [{
      idempotency_key: idempotencyKey,
      photo_identity_kind: "content_sha256_set_v1",
      photo_identity_fingerprint: canonicalizeVerifiedPhotoSet([
        "a".repeat(64),
      ]).fingerprint,
    }],
    p_user_id: user.id,
  });
  if (staged.error) throw new Error(staged.error.message);
  const row = (staged.data as Array<{
    item_id: string;
    run_id: string;
    queue_message_id: string | number;
  }>)[0];
  queueMessageIds.add(String(row.queue_message_id));
  const worker = createSupabasePipelineWorkerStore(
    admin as unknown as PipelineWorkerRpcClient,
  );
  const acquisition = await worker.acquire({
    runId: row.run_id,
    messageId: String(row.queue_message_id),
    leaseSeconds: 60,
  });
  expect(acquisition.kind).toBe("acquired");
  const attempt = acquisition as Extract<
    PipelineAttemptAcquisition,
    { kind: "acquired" }
  >;
  const result: PipelineResult = {
    attributes: { brand: `Old ${label}`, category: "electronics", condition: "fair" },
    identification: { label: `Old ${label}`, confident: true, evidence: 1 },
    price: {
      suggested: 100,
      range: { min: 80, max: 120 },
      confidence: 0.7,
      sources: [],
      tier: "llm-only",
    },
    confidence: { score: 0.7, band: "medium", autopilotEligible: false },
    listing: {
      platform: "ebay",
      title: `Old ${label} listing`,
      description: "Old coherent copy",
      fields: {},
    },
    model: "test-vision",
    listingModel: "test-listing",
  };
  await worker.checkpoint({
    runId: row.run_id,
    leaseToken: attempt.context.run.lease_token,
    stage: "generating",
    checkpoint: {
      identified: {
        attributes: result.attributes,
        identification: result.identification,
        model: result.model,
      },
      priced: {
        result: result.price,
        evidenceAsOf: "2026-07-20T08:00:00.000Z",
      },
      generated: { copy: result.listing, model: result.listingModel! },
    },
    leaseSeconds: 60,
  });
  const completion = await worker.complete({
    runId: row.run_id,
    leaseToken: attempt.context.run.lease_token,
    result,
    autopilotEnabled: false,
  });
  const { data: item } = await user.client
    .from("items")
    .select("review_revision")
    .eq("id", row.item_id)
    .single();
  const reviewRevision = crypto.randomUUID();
  const edit = await user.client.rpc("save_review_edits", {
    p_item_id: row.item_id,
    p_listing_id: completion.listingId,
    p_expected_review_revision: item?.review_revision,
    p_new_review_revision: reviewRevision,
    p_attributes: result.attributes,
    p_condition: "fair",
    p_price_override: 222,
    p_cost_basis: null,
    p_listing_title: `Old ${label} listing`,
    p_listing_description: "Old coherent copy",
  });
  if (edit.error) throw new Error(edit.error.message);
  originalRunIds.set(row.item_id, row.run_id);
  return {
    itemId: row.item_id,
    listingId: completion.listingId,
    reviewRevision,
  };
}

function commitFor(
  itemId: string,
  listingId: string,
  runId: string,
  expectedReviewRevision: string,
  expectedRunId: string | null = originalRunIds.get(itemId) ?? null,
): ReviewRegenerationCommit {
  const attributes = {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    upc: "027242919662",
    specs: ["wireless", "noise-cancelling"],
    title: "Sony WH-1000XM4",
  };
  return {
    capabilityToken: "A".repeat(43),
    itemId,
    listingId,
    runId,
    expectedRunId,
    expectedReviewRevision,
    result: {
      attributes,
      identification: {
        label: "Sony WH-1000XM4",
        confident: true,
        evidence: 1,
      },
      listing: {
        platform: "ebay",
        title: "Sony WH-1000XM4 Wireless Headphones",
        description: "Corrected coherent copy",
        fields: { itemSpecifics: { Brand: "Sony", Model: "WH-1000XM4" } },
      },
      price: {
        suggested: 165,
        range: { min: 145, max: 185 },
        confidence: 0.85,
        sources: [{ url: "https://www.ebay.com/itm/1", kind: "sold-comp" }],
        tier: "ebay-sold",
        evidence: [{
          id: "https://www.ebay.com/itm/1",
          sourceUrl: "https://www.ebay.com/itm/1",
          price: 165,
          currency: "USD",
          condition: "good",
          kind: "sold-comparable",
          priceDisclosure: "displayed-sold-price",
        }],
      },
      confidence: { score: 0.85, band: "high", autopilotEligible: false },
      model: "vision-model",
      listingModel: "listing-model",
    },
  };
}

function guidedGateway(user: ClerkTestUser) {
  return createSupabaseGuidedCorrectionCompletionGateway(
    user.client,
    admin as unknown as GuidedCorrectionCompletionRpcClient,
  );
}

async function commitCorrection(
  user: ClerkTestUser,
  commit: ReviewRegenerationCommit,
): Promise<void> {
  const gateway = guidedGateway(user);
  const capability = await gateway.authorize({
    itemId: commit.itemId,
    listingId: commit.listingId,
    runId: commit.runId,
    expectedRunId: commit.expectedRunId,
    expectedReviewRevision: commit.expectedReviewRevision,
  });
  await gateway.complete({ ...commit, capabilityToken: capability.token });
}

async function buildCompletionRpcCommit(
  user: ClerkTestUser,
  commit: ReviewRegenerationCommit,
): Promise<Record<string, unknown>> {
  let captured: unknown;
  const captureClient: GuidedCorrectionCompletionRpcClient = {
    async rpc(_functionName, args) {
      captured = args.p_commit;
      return { data: true, error: null };
    },
  };
  await createSupabaseGuidedCorrectionCompletionGateway(
    user.client,
    captureClient,
  ).complete(commit);
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) {
    throw new Error("Guided correction completion commit was not constructed.");
  }
  return captured as Record<string, unknown>;
}

async function correctionState(user: ClerkTestUser, itemIds: string[]) {
  const [items, listings, predictions, reservations, periods, snapshots] =
    await Promise.all([
      user.client
        .from("items")
        .select(
          "id,attributes,condition,identification,price_override,review_revision,review_content_revision",
        )
        .in("id", itemIds)
        .order("id"),
      user.client
        .from("listings")
        .select(
          "id,item_id,title,description,copy,status,run_id,source_review_revision",
        )
        .in("item_id", itemIds)
        .order("id"),
      user.client
        .from("prediction_logs")
        .select(
          "id,item_id,run_id,extracted_attrs,price,price_range,confidence,tier_fired,sources",
        )
        .in("item_id", itemIds)
        .order("id"),
      user.client
        .from("ai_item_credit_reservations")
        .select(
          "id,item_id,state,guided_correction_revision,guided_correction_started_at,guided_correction_completed_at,settled_at,updated_at",
        )
        .in("item_id", itemIds)
        .order("id"),
      user.client
        .from("ai_item_allowance_periods")
        .select("id,source,period_key,state,allowance,updated_at")
        .order("id"),
      user.client
        .from("pricing_evidence_snapshots")
        .select(
          "run_id,item_id,prediction_id,listing_id,price_result,evidence,evidence_as_of",
        )
        .in("item_id", itemIds)
        .order("run_id"),
    ]);
  for (const response of [
    items,
    listings,
    predictions,
    reservations,
    periods,
    snapshots,
  ]) {
    expect(response.error).toBeNull();
  }
  return {
    items: items.data,
    listings: listings.data,
    predictions: predictions.data,
    reservations: reservations.data,
    periods: periods.data,
    snapshots: snapshots.data,
  };
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "review_regen_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "review_regen_b"),
  ]);
  const now = Date.now();
  for (const user of [userA, userB]) {
    const period = await admin.rpc("record_verified_storekit_ai_item_period", {
      p_allowance: 100,
      p_event_created_at: new Date(now).toISOString(),
      p_event_id: crypto.randomUUID(),
      p_expires_date: new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      p_grace_expires_date: null,
      p_original_transaction_id: `review-${user.id}`,
      p_period_key: `review-${crypto.randomUUID()}`,
      p_period_start: new Date(now - 60_000).toISOString(),
      p_state: "active",
      p_user_id: user.id,
    });
    if (period.error) throw new Error(period.error.message);
  }
});

afterAll(async () => {
  if (!reachable) return;
  await Promise.all(
    [...queueMessageIds].map((messageId) =>
      admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
    ),
  );
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("review identity regeneration transaction + RLS", () => {
  it("reports when the local Supabase integration seam is unavailable", () => {
    if (!reachable) {
      console.warn(
        "[review-regeneration.rls.test] Local Supabase unavailable — DB-gated assertions skipped.",
      );
    }
    expect(true).toBe(true);
  });

  it("atomically persists corrected identity/listing/log and preserves price override", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "owner");
    const { error: exportSeedError } = await userA.client.from("listings").insert({
      user_id: userA.id,
      item_id: seeded.itemId,
      platform: "facebook",
      title: "Old identity export",
      description: "Stale cached copy",
      copy: {},
      status: "draft",
    });
    expect(exportSeedError).toBeNull();
    const runId = crypto.randomUUID();
    await commitCorrection(
      userA,
      commitFor(seeded.itemId, seeded.listingId, runId, seeded.reviewRevision),
    );

    const [{ data: item }, { data: listing }, { data: logs }, { data: exports }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, condition, identification, price_override")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title, description, status, run_id")
        .eq("id", seeded.listingId)
        .single(),
      userA.client
        .from("prediction_logs")
        .select("run_id, extracted_attrs, price, sources")
        .eq("item_id", seeded.itemId)
        .eq("run_id", runId),
      userA.client
        .from("listings")
        .select("id")
        .eq("item_id", seeded.itemId)
        .in("platform", ["facebook", "mercari"]),
    ]);

    expect((item?.attributes as { model?: string })?.model).toBe("WH-1000XM4");
    expect(item?.condition).toBe("good");
    expect(Number(item?.price_override)).toBe(222);
    expect((item?.identification as { label?: string })?.label).toBe("Sony WH-1000XM4");
    expect(listing).toMatchObject({
      title: "Sony WH-1000XM4 Wireless Headphones",
      description: "Corrected coherent copy",
      status: "draft",
      run_id: runId,
    });
    expect(logs).toHaveLength(1);
    expect(Number(logs?.[0]?.price)).toBe(165);
    expect(exports ?? []).toHaveLength(0);
  });

  it("accepts strict-reader-valid URL, Unicode, and JS whitespace at the authenticated correction seam", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "reader-valid-evidence");
    const runId = crypto.randomUUID();
    const commit = commitFor(
      seeded.itemId,
      seeded.listingId,
      runId,
      seeded.reviewRevision,
    );
    const source = {
      url: "HTTPS://example.com:443/valid",
      kind: "sold-comp" as const,
    };
    const title = "界".repeat(167);
    commit.result.identification!.label = `\u00a0${title}\u00a0`;
    commit.result.attributes.condition = "\u00a0good\u00a0";
    commit.result.price.sources = [source];
    commit.result.price.evidence = (commit.result.price.evidence ?? []).map(
      (record) => ({ ...record, id: source.url, sourceUrl: source.url }),
    );
    const snapshot = buildPricingEvidenceSnapshotInput(commit.result);

    expect(
      pricingEvidenceSnapshotInputSchema.safeParse(snapshot).success,
    ).toBe(true);
    expect(snapshot.item).toEqual({ title, condition: "good" });

    await expect(commitCorrection(userA, commit)).resolves.toBeUndefined();

    const pricingReader = createSupabasePricingEvidenceReader(
      async () => userA.client,
    );
    await expect(
      pricingReader.forItem({
        userId: userA.id,
        bearerToken: "test",
        itemId: seeded.itemId,
        now: Date.now() + 1_000,
      }),
    ).resolves.toMatchObject({
      item: { id: seeded.itemId, title, condition: "good" },
      priceResult: { suggested: 165, sources: [source] },
      comparables: [expect.objectContaining({ sourceUrl: source.url })],
    });
  });

  it("rejects malformed and mismatched capabilities at the real role without mutation", async () => {
    if (!reachable) return;
    const owner = await seedReview(userA, "capability-owner");
    const sibling = await seedReview(userA, "capability-sibling");
    const foreign = await seedReview(userB, "capability-foreign");
    const token = `${crypto.randomUUID().replaceAll("-", "")}A`.padEnd(43, "A");
    const randomToken = `${crypto.randomUUID().replaceAll("-", "")}B`.padEnd(
      43,
      "B",
    );
    const runId = crypto.randomUUID();
    const authorization = await userA.client.rpc(
      "authorize_ai_item_guided_correction",
      {
        p_completion_run_id: runId,
        p_completion_token: token,
        p_expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
        p_expected_review_revision: owner.reviewRevision,
        p_expected_run_id: originalRunIds.get(owner.itemId),
        p_item_id: owner.itemId,
        p_listing_id: owner.listingId,
      },
    );
    expect(authorization.error).toBeNull();

    const commit = commitFor(
      owner.itemId,
      owner.listingId,
      runId,
      owner.reviewRevision,
    );
    const rpcCommit = await buildCompletionRpcCommit(userA, {
      ...commit,
      capabilityToken: token,
    });
    const confidenceDivergence = structuredClone(rpcCommit) as typeof rpcCommit & {
      pricing_snapshot: { price_result: { confidence: number } };
    };
    confidenceDivergence.pricing_snapshot.price_result.confidence = 0.01;
    const missingConfidence = structuredClone(rpcCommit) as unknown as {
      prediction: Record<string, unknown>;
      pricing_snapshot: { price_result: Record<string, unknown> };
    };
    delete missingConfidence.prediction.confidence;
    delete missingConfidence.pricing_snapshot.price_result.confidence;
    const ownerItemIds = [owner.itemId, sibling.itemId];
    const ownerBefore = await correctionState(userA, ownerItemIds);
    const foreignBefore = await correctionState(userB, [foreign.itemId]);
    const pricingReader = createSupabasePricingEvidenceReader(
      async () => userA.client,
    );
    const readNow = Date.now() + 1_000;
    const priorEvidence = await pricingReader.forItem({
      userId: userA.id,
      bearerToken: "test",
      itemId: owner.itemId,
      now: readNow,
    });
    expect(priorEvidence).toMatchObject({
      item: { id: owner.itemId },
      priceResult: { suggested: 100, tier: "llm-only" },
    });

    const attempts: Array<{
      name: string;
      capabilityToken: string;
      commit: Record<string, unknown>;
      message: RegExp;
    }> = [
      {
        name: "malformed token",
        capabilityToken: "short",
        commit: structuredClone(rpcCommit),
        message: /invalid guided correction completion/i,
      },
      {
        name: "random token",
        capabilityToken: randomToken,
        commit: structuredClone(rpcCommit),
        message: /capability is unavailable/i,
      },
      {
        name: "cross-tenant item",
        capabilityToken: token,
        commit: { ...structuredClone(rpcCommit), item_id: foreign.itemId },
        message: /capability binding mismatch/i,
      },
      {
        name: "cross-item",
        capabilityToken: token,
        commit: { ...structuredClone(rpcCommit), item_id: sibling.itemId },
        message: /capability binding mismatch/i,
      },
      {
        name: "cross-completion-run",
        capabilityToken: token,
        commit: { ...structuredClone(rpcCommit), run_id: crypto.randomUUID() },
        message: /capability binding mismatch/i,
      },
      {
        name: "cross-prior-run",
        capabilityToken: token,
        commit: {
          ...structuredClone(rpcCommit),
          expected_run_id: crypto.randomUUID(),
        },
        message: /capability binding mismatch/i,
      },
      {
        name: "cross-revision",
        capabilityToken: token,
        commit: {
          ...structuredClone(rpcCommit),
          expected_review_revision: crypto.randomUUID(),
        },
        message: /capability binding mismatch/i,
      },
      {
        name: "snapshot confidence diverges from the canonical prediction",
        capabilityToken: token,
        commit: confidenceDivergence,
        message: /guided correction persistence is incoherent/i,
      },
      {
        name: "snapshot and prediction both omit confidence",
        capabilityToken: token,
        commit: missingConfidence,
        message: /invalid guided correction completion/i,
      },
    ];

    for (const attempt of attempts) {
      const response = await admin.rpc("complete_guided_review_correction", {
        p_completion_token: attempt.capabilityToken,
        p_commit: attempt.commit,
      });
      expect({ name: attempt.name, message: response.error?.message }).toEqual({
        name: attempt.name,
        message: expect.stringMatching(attempt.message),
      });
    }

    await expect(correctionState(userA, ownerItemIds)).resolves.toEqual(
      ownerBefore,
    );
    await expect(correctionState(userB, [foreign.itemId])).resolves.toEqual(
      foreignBefore,
    );
    await expect(
      pricingReader.forItem({
        userId: userA.id,
        bearerToken: "test",
        itemId: owner.itemId,
        now: readNow,
      }),
    ).resolves.toEqual(priorEvidence);
  });

  it("rejects an expired capability without mutating review state", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "expired-capability");
    const token = "B".repeat(43);
    const runId = crypto.randomUUID();
    const authorization = await userA.client.rpc(
      "authorize_ai_item_guided_correction",
      {
        p_completion_run_id: runId,
        p_completion_token: token,
        p_expires_at: new Date(Date.now() + 1_500).toISOString(),
        p_expected_review_revision: seeded.reviewRevision,
        p_expected_run_id: originalRunIds.get(seeded.itemId),
        p_item_id: seeded.itemId,
        p_listing_id: seeded.listingId,
      },
    );
    expect(authorization.error).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    const expired = await admin.rpc("complete_guided_review_correction", {
      p_completion_token: token,
      p_commit: {},
    });
    expect(expired.error?.message).toMatch(/capability is unavailable/i);
    const { data: item } = await userA.client
      .from("items")
      .select("attributes, review_revision")
      .eq("id", seeded.itemId)
      .single();
    expect((item?.attributes as { brand?: string })?.brand).toBe(
      "Old expired-capability",
    );
    expect(item?.review_revision).toBe(seeded.reviewRevision);
  });

  it("caps a clock-ahead capability expiry at the database five-minute maximum", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "clock-ahead-capability");
    const commit = commitFor(
      seeded.itemId,
      seeded.listingId,
      crypto.randomUUID(),
      seeded.reviewRevision,
    );
    const applicationNow = Date.now() + 30_000;
    const requestedExpiry = applicationNow + GUIDED_CORRECTION_CAPABILITY_TTL_MS;
    const gateway = createSupabaseGuidedCorrectionCompletionGateway(
      userA.client,
      admin as unknown as GuidedCorrectionCompletionRpcClient,
      { now: () => applicationNow },
    );

    const capability = await gateway.authorize({
      itemId: commit.itemId,
      listingId: commit.listingId,
      runId: commit.runId,
      expectedRunId: commit.expectedRunId,
      expectedReviewRevision: commit.expectedReviewRevision,
    });

    expect(Date.parse(capability.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(capability.expiresAt)).toBeLessThan(requestedExpiry);
  });

  it("consumes one capability exactly once under concurrent completion", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "concurrent-capability");
    const commit = commitFor(
      seeded.itemId,
      seeded.listingId,
      crypto.randomUUID(),
      seeded.reviewRevision,
    );
    const gateway = guidedGateway(userA);
    const capability = await gateway.authorize({
      itemId: commit.itemId,
      listingId: commit.listingId,
      runId: commit.runId,
      expectedRunId: commit.expectedRunId,
      expectedReviewRevision: commit.expectedReviewRevision,
    });
    const completion = { ...commit, capabilityToken: capability.token };
    const results = await Promise.allSettled([
      gateway.complete(completion),
      gateway.complete(completion),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const { data: logs } = await userA.client
      .from("prediction_logs")
      .select("id")
      .eq("run_id", commit.runId);
    expect(logs ?? []).toHaveLength(1);
  });

  it("rejects evidence divergent from cited sources before privileged completion", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "divergent-evidence");
    const runId = crypto.randomUUID();
    const divergent = commitFor(
      seeded.itemId,
      seeded.listingId,
      runId,
      seeded.reviewRevision,
    );
    divergent.result.price.evidence![0].sourceUrl = "https://example.com/divergent";

    await expect(commitCorrection(userA, divergent)).rejects.toThrow(
      /match a cited source URL/i,
    );

    const [{ data: item }, { data: listing }, { data: logs }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, condition")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title, run_id")
        .eq("id", seeded.listingId)
        .single(),
      userA.client.from("prediction_logs").select("id").eq("run_id", runId),
    ]);
    expect((item?.attributes as { brand?: string })?.brand).toBe(
      "Old divergent-evidence",
    );
    expect(item?.condition).toBe("fair");
    expect(listing).toMatchObject({
      title: "Old divergent-evidence listing",
      run_id: originalRunIds.get(seeded.itemId),
    });
    expect(logs ?? []).toHaveLength(0);
  });

  it("rolls back item/listing mutations when a cross-tenant run collision fails later", async () => {
    if (!reachable) return;
    const owner = await seedReview(userA, "rollback-owner");
    const foreign = await seedReview(userB, "foreign");
    const runId = originalRunIds.get(foreign.itemId)!;

    // Authorization is correctly bound to A's item/listing. The supplied new run
    // identity already belongs to B's prediction, so the transaction fails only
    // after its item/listing updates and must roll those earlier writes back.
    await expect(
      commitCorrection(
        userA,
        commitFor(owner.itemId, owner.listingId, runId, owner.reviewRevision),
      ),
    ).rejects.toThrow();

    const { data: item } = await userA.client
      .from("items")
      .select("attributes, condition, price_override")
      .eq("id", owner.itemId)
      .single();
    expect((item?.attributes as { brand?: string })?.brand).toBe("Old rollback-owner");
    expect(item?.condition).toBe("fair");
    expect(Number(item?.price_override)).toBe(222);

    const { data: logs } = await userA.client
      .from("prediction_logs")
      .select("id")
      .eq("run_id", runId);
    expect(logs ?? []).toHaveLength(0);

    const { data: bVisibleToA } = await userA.client
      .from("listings")
      .select("id")
      .eq("id", foreign.listingId);
    expect(bVisibleToA ?? []).toHaveLength(0);
  });

  it("rejects a stale regeneration version and keeps the newer coherent run", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "stale-regeneration");
    const firstRunId = crypto.randomUUID();
    const first = commitFor(
      seeded.itemId,
      seeded.listingId,
      firstRunId,
      seeded.reviewRevision,
    );
    first.result.attributes.brand = "Newest identity";
    await commitCorrection(userA, first);

    const staleRunId = crypto.randomUUID();
    const stale = commitFor(
      seeded.itemId,
      seeded.listingId,
      staleRunId,
      seeded.reviewRevision,
    );
    stale.result.attributes.brand = "Stale identity";
    await expect(commitCorrection(userA, stale)).rejects.toThrow(/review changed/i);

    const [{ data: item }, { data: listing }, { data: staleLogs }] = await Promise.all([
      userA.client.from("items").select("attributes").eq("id", seeded.itemId).single(),
      userA.client.from("listings").select("run_id").eq("id", seeded.listingId).single(),
      userA.client.from("prediction_logs").select("id").eq("run_id", staleRunId),
    ]);
    expect((item?.attributes as { brand?: string })?.brand).toBe("Newest identity");
    expect(listing?.run_id).toBe(firstRunId);
    expect(staleLogs ?? []).toHaveLength(0);
  });

  it("rejects a zero-price recommendation and retains the previous coherent state", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "zero-price");
    const runId = crypto.randomUUID();
    const invalid = commitFor(
      seeded.itemId,
      seeded.listingId,
      runId,
      seeded.reviewRevision,
    );
    invalid.result.price.suggested = 0;

    await expect(commitCorrection(userA, invalid)).rejects.toThrow();

    const [{ data: item }, { data: listing }, { data: logs }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, condition, price_override")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title, description, run_id")
        .eq("id", seeded.listingId)
        .single(),
      userA.client
        .from("prediction_logs")
        .select("id")
        .eq("run_id", runId),
    ]);

    expect((item?.attributes as { brand?: string })?.brand).toBe("Old zero-price");
    expect(item?.condition).toBe("fair");
    expect(Number(item?.price_override)).toBe(222);
    expect(listing).toMatchObject({
      title: "Old zero-price listing",
      description: "Old coherent copy",
      run_id: originalRunIds.get(seeded.itemId),
    });
    expect(logs ?? []).toHaveLength(0);
  });

  it("rejects authoritative live state and an in-flight publish claim", async () => {
    if (!reachable) return;

    const live = await seedReview(userA, "authoritative-live");
    const { error: liveStateError } = await userA.client
      .from("listings")
      .update({
        ebay_listing_id: "v1|1234567890|0",
        ebay_status: "published",
      })
      .eq("id", live.listingId);
    expect(liveStateError).toBeNull();
    await expect(
      commitCorrection(
        userA,
        commitFor(
          live.itemId,
          live.listingId,
          crypto.randomUUID(),
          live.reviewRevision,
        ),
      ),
    ).rejects.toThrow(/editable eBay listing not found/i);

    const publishing = await seedReview(userA, "publishing-claim");
    const claim = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: publishing.listingId,
      p_expected_run_id: originalRunIds.get(publishing.itemId),
      p_expected_review_revision: publishing.reviewRevision,
    });
    expect(claim.error).toBeNull();
    await expect(
      commitCorrection(
        userA,
        commitFor(
          publishing.itemId,
          publishing.listingId,
          crypto.randomUUID(),
          claim.data.claimId as string,
        ),
      ),
    ).rejects.toThrow(/editable eBay listing not found/i);

    const [{ data: liveItem }, { data: publishingItem }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes")
        .eq("id", live.itemId)
        .single(),
      userA.client
        .from("items")
        .select("attributes")
        .eq("id", publishing.itemId)
        .single(),
    ]);
    expect((liveItem?.attributes as { brand?: string })?.brand).toBe(
      "Old authoritative-live",
    );
    expect((publishingItem?.attributes as { brand?: string })?.brand).toBe(
      "Old publishing-claim",
    );
  });

  it("rejects a sibling eBay listing for the same item", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "duplicate-ebay-listing");
    const { error: extraError } = await userA.client.from("listings").insert({
      user_id: userA.id,
      item_id: seeded.itemId,
      platform: "ebay",
      title: "Sibling draft",
      description: "Must not remain independently publishable",
      copy: {},
      status: "draft",
    });
    expect(extraError?.code).toBe("23505");

    const [{ data: ownerSnapshot, error: ownerSnapshotError }, { data: foreignSnapshot }] =
      await Promise.all([
        userA.client.rpc("get_review_snapshot", { p_item_id: seeded.itemId }),
        userB.client.rpc("get_review_snapshot", { p_item_id: seeded.itemId }),
      ]);
    expect(ownerSnapshotError).toBeNull();
    expect(ownerSnapshot).toMatchObject({
      listing: { id: seeded.listingId },
      reviewBlocked: false,
    });
    expect(foreignSnapshot).toBeNull();
  });

  it("rejects a listing attached to another tenant's item", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "cross-tenant-item-link");

    const { error } = await userB.client.from("listings").insert({
      user_id: userB.id,
      item_id: seeded.itemId,
      platform: "facebook",
      title: "Cross-tenant draft",
      description: "Must never attach to another seller's item",
      copy: {},
      status: "draft",
    });
    expect(error?.code).toBe("23503");

    const { data: ownerListings } = await userA.client
      .from("listings")
      .select("id")
      .eq("item_id", seeded.itemId);
    expect(ownerListings ?? []).toHaveLength(1);
  });

  it("checks and advances one review revision while ordinary save preserves identity", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "shared-review-revision");
    const savedRevision = crypto.randomUUID();
    const savedAttributes = {
      brand: "Forged brand",
      category: "forged category",
      condition: "poor",
    };
    const saved = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: savedRevision,
      p_attributes: savedAttributes,
      p_condition: "poor",
      p_price_override: 199,
      p_cost_basis: 80,
      p_listing_title: "Seller edited title",
      p_listing_description: "Seller edited description",
    });
    expect(saved.error).toBeNull();

    const { data: savedItem } = await userA.client
      .from("items")
      .select("attributes, condition")
      .eq("id", seeded.itemId)
      .single();
    expect((savedItem?.attributes as { brand?: string; category?: string })?.brand).toBe(
      "Old shared-review-revision",
    );
    expect((savedItem?.attributes as { category?: string })?.category).toBe(
      "electronics",
    );
    expect(savedItem?.condition).toBe("fair");

    const stale = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: crypto.randomUUID(),
      p_attributes: { ...savedAttributes, brand: "Stale brand" },
      p_condition: "poor",
      p_price_override: 199,
      p_cost_basis: 80,
      p_listing_title: "Stale title",
      p_listing_description: "Stale description",
    });
    expect(stale.error?.code).toBe("P0002");

    const sharpenRevision = crypto.randomUUID();
    const sharpenedAttributes = {
      brand: "Old shared-review-revision",
      category: "electronics",
      condition: "fair",
      specs: ["512GB"],
    };
    const sharpened = await userA.client.rpc("sharpen_review_estimate", {
      p_item_id: seeded.itemId,
      p_expected_review_revision: savedRevision,
      p_run_id: sharpenRevision,
      p_attributes: sharpenedAttributes,
      p_price: 175,
      p_price_range: { low: 160, high: 190 },
      p_confidence: 0.8,
      p_tier_fired: "ebay-sold",
      p_model: "vision-model",
      p_listing_model: "listing-model",
      p_pricing_model: null,
      p_sources: [{ url: "https://www.ebay.com/itm/1", kind: "sold-comp" }],
      p_autopilot_enabled: false,
      p_autopilot_eligible: false,
    });
    expect(sharpened.error).toBeNull();

    const [{ data: item }, { data: listing }, { data: logs }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, condition, review_revision")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title")
        .eq("id", seeded.listingId)
        .single(),
      userA.client
        .from("prediction_logs")
        .select("run_id")
        .eq("run_id", sharpenRevision),
    ]);
    expect(item?.review_revision).toBe(sharpenRevision);
    expect((item?.attributes as { brand?: string; category?: string })?.brand).toBe(
      "Old shared-review-revision",
    );
    expect((item?.attributes as { category?: string })?.category).toBe("electronics");
    expect(item?.condition).toBe("fair");
    expect(listing?.title).toBe("Seller edited title");
    expect(logs ?? []).toHaveLength(1);
  });

  it("rejects ordinary review saves for an authoritative live eBay listing", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "live-save-guard");
    const { error: liveStateError } = await userA.client
      .from("listings")
      .update({
        ebay_listing_id: "v1|9876543210|0",
        ebay_status: "published",
      })
      .eq("id", seeded.listingId);
    expect(liveStateError).toBeNull();

    const saved = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: crypto.randomUUID(),
      p_attributes: { brand: "Forged", category: "electronics" },
      p_condition: "fair",
      p_price_override: 199,
      p_cost_basis: 80,
      p_listing_title: "Stale seller title",
      p_listing_description: "Stale seller description",
    });
    expect(saved.error?.code).toBe("P0002");

    const [{ data: item }, { data: listing }] = await Promise.all([
      userA.client
        .from("items")
        .select("price_override, review_revision")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title, description")
        .eq("id", seeded.listingId)
        .single(),
    ]);
    expect(Number(item?.price_override)).toBe(222);
    expect(item?.review_revision).toBe(seeded.reviewRevision);
    expect(listing).toMatchObject({
      title: "Old live-save-guard listing",
      description: "Old coherent copy",
    });
  });

  it("rejects sharpened estimates for an authoritative live eBay listing", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "live-sharpen-guard");
    const { error: liveStateError } = await userA.client
      .from("listings")
      .update({ ebay_status: "publishing" })
      .eq("id", seeded.listingId);
    expect(liveStateError).toBeNull();

    const runId = crypto.randomUUID();
    const sharpened = await userA.client.rpc("sharpen_review_estimate", {
      p_item_id: seeded.itemId,
      p_expected_review_revision: seeded.reviewRevision,
      p_run_id: runId,
      p_attributes: {
        brand: "Stale sharpened brand",
        category: "electronics",
        condition: "fair",
      },
      p_price: 175,
      p_price_range: { low: 160, high: 190 },
      p_confidence: 0.8,
      p_tier_fired: "ebay-sold",
      p_model: "vision-model",
      p_listing_model: "listing-model",
      p_pricing_model: null,
      p_sources: [],
      p_autopilot_enabled: false,
      p_autopilot_eligible: false,
    });
    expect(sharpened.error?.code).toBe("P0002");

    const [{ data: item }, { data: logs }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, review_revision")
        .eq("id", seeded.itemId)
        .single(),
      userA.client.from("prediction_logs").select("id").eq("run_id", runId),
    ]);
    expect((item?.attributes as { brand?: string })?.brand).toBe(
      "Old live-sharpen-guard",
    );
    expect(item?.review_revision).toBe(seeded.reviewRevision);
    expect(logs ?? []).toHaveLength(0);
  });

  it("advances write exclusion without invalidating export content on publish claim", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "publish-revision");
    const claim = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: originalRunIds.get(seeded.itemId),
      p_expected_review_revision: seeded.reviewRevision,
    });
    expect(claim.error).toBeNull();

    const { data: item } = await userA.client
      .from("items")
      .select("review_revision, review_content_revision")
      .eq("id", seeded.itemId)
      .single();
    expect(item?.review_revision).toBe(claim.data.claimId);
    expect(item?.review_content_revision).toBe(seeded.reviewRevision);
    expect(claim.data).toMatchObject({
      listingId: seeded.listingId,
      title: "Old publish-revision listing",
      description: "Old coherent copy",
    });

    const exportAfterClaim = await userA.client.rpc("persist_export_packs", {
      p_item_id: seeded.itemId,
      p_source_review_revision: seeded.reviewRevision,
      p_expected_review_revision: claim.data.claimId,
      p_packs: [
        {
          platform: "facebook",
          title: "Still current pack",
          description: "Publish did not change review content",
          copy: { copyBlock: "Still current pack" },
        },
      ],
    });
    expect(exportAfterClaim.error).toBeNull();

    const staleSave = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: crypto.randomUUID(),
      p_attributes: { brand: "Stale", category: "electronics" },
      p_condition: "fair",
      p_price_override: null,
      p_cost_basis: null,
      p_listing_title: "Stale title",
      p_listing_description: "Stale description",
    });
    expect(staleSave.error?.code).toBe("P0002");

    const staleSharpen = await userA.client.rpc("sharpen_review_estimate", {
      p_item_id: seeded.itemId,
      p_expected_review_revision: seeded.reviewRevision,
      p_run_id: crypto.randomUUID(),
      p_attributes: {
        brand: "Stale sharpen",
        category: "electronics",
        condition: "fair",
      },
      p_price: 175,
      p_price_range: { low: 160, high: 190 },
      p_confidence: 0.8,
      p_tier_fired: "ebay-sold",
      p_model: "vision-model",
      p_listing_model: "listing-model",
      p_pricing_model: null,
      p_sources: [],
      p_autopilot_enabled: false,
      p_autopilot_eligible: false,
    });
    expect(staleSharpen.error?.code).toBe("P0002");
  });

  it("rejects an export pack persisted from an obsolete review revision", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "stale-export-pack");
    const currentRevision = crypto.randomUUID();
    const saved = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: currentRevision,
      p_attributes: { brand: "Current brand", category: "electronics" },
      p_condition: "good",
      p_price_override: null,
      p_cost_basis: null,
      p_listing_title: "Current listing",
      p_listing_description: "Current description",
    });
    expect(saved.error).toBeNull();

    const packs = [
      {
        platform: "facebook",
        title: "Stale Facebook pack",
        description: "Stale identity copy",
        copy: { copyBlock: "Stale Facebook pack\n\nStale identity copy" },
      },
    ];
    const stale = await userA.client.rpc("persist_export_packs", {
      p_item_id: seeded.itemId,
      p_source_review_revision: seeded.reviewRevision,
      p_expected_review_revision: currentRevision,
      p_packs: packs,
    });
    expect(stale.error?.code).toBe("P0002");

    const current = await userA.client.rpc("persist_export_packs", {
      p_item_id: seeded.itemId,
      p_source_review_revision: currentRevision,
      p_expected_review_revision: currentRevision,
      p_packs: packs,
    });
    expect(current.error).toBeNull();

    const { data: rows } = await userA.client
      .from("listings")
      .select("source_review_revision")
      .eq("item_id", seeded.itemId)
      .eq("platform", "facebook");
    expect(rows ?? []).toEqual([
      expect.objectContaining({ source_review_revision: currentRevision }),
    ]);
  });

  it("replaces an invalid current export pack and prunes packs on save and sharpen", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "export-pack-lifecycle");
    const invalidPack = [
      {
        platform: "mercari",
        title: "x".repeat(41),
        description: "Invalid cached copy",
        copy: { copyBlock: "invalid" },
      },
    ];
    expect(
      (
        await userA.client.rpc("persist_export_packs", {
          p_item_id: seeded.itemId,
          p_source_review_revision: seeded.reviewRevision,
          p_expected_review_revision: seeded.reviewRevision,
          p_packs: invalidPack,
        })
      ).error,
    ).toBeNull();

    const validPack = [
      {
        platform: "mercari",
        title: "Valid current pack",
        description: "Valid regenerated copy",
        copy: { copyBlock: "Valid current pack\n\nValid regenerated copy" },
      },
    ];
    expect(
      (
        await userA.client.rpc("persist_export_packs", {
          p_item_id: seeded.itemId,
          p_source_review_revision: seeded.reviewRevision,
          p_expected_review_revision: seeded.reviewRevision,
          p_packs: validPack,
        })
      ).error,
    ).toBeNull();

    const { data: replacedRows } = await userA.client
      .from("listings")
      .select("title")
      .eq("item_id", seeded.itemId)
      .eq("platform", "mercari");
    expect(replacedRows ?? []).toEqual([{ title: "Valid current pack" }]);

    const savedRevision = crypto.randomUUID();
    expect(
      (
        await userA.client.rpc("save_review_edits", {
          p_item_id: seeded.itemId,
          p_listing_id: seeded.listingId,
          p_expected_review_revision: seeded.reviewRevision,
          p_new_review_revision: savedRevision,
          p_attributes: {
            brand: "Old export-pack-lifecycle",
            category: "electronics",
            condition: "fair",
          },
          p_condition: "fair",
          p_price_override: null,
          p_cost_basis: null,
          p_listing_title: "Seller edited title",
          p_listing_description: "Seller edited description",
        })
      ).error,
    ).toBeNull();

    const { data: afterSave } = await userA.client
      .from("listings")
      .select("id")
      .eq("item_id", seeded.itemId)
      .in("platform", ["facebook", "mercari"]);
    expect(afterSave ?? []).toHaveLength(0);

    expect(
      (
        await userA.client.rpc("persist_export_packs", {
          p_item_id: seeded.itemId,
          p_source_review_revision: savedRevision,
          p_expected_review_revision: savedRevision,
          p_packs: validPack,
        })
      ).error,
    ).toBeNull();

    const sharpenRevision = crypto.randomUUID();
    expect(
      (
        await userA.client.rpc("sharpen_review_estimate", {
          p_item_id: seeded.itemId,
          p_expected_review_revision: savedRevision,
          p_run_id: sharpenRevision,
          p_attributes: {
            brand: "Old export-pack-lifecycle",
            category: "electronics",
            condition: "fair",
            specs: ["512GB"],
          },
          p_price: 175,
          p_price_range: { low: 160, high: 190 },
          p_confidence: 0.8,
          p_tier_fired: "ebay-sold",
          p_model: "vision-model",
          p_listing_model: "listing-model",
          p_pricing_model: null,
          p_sources: [],
          p_autopilot_enabled: false,
          p_autopilot_eligible: false,
        })
      ).error,
    ).toBeNull();

    const { data: afterSharpen } = await userA.client
      .from("listings")
      .select("id")
      .eq("item_id", seeded.itemId)
      .in("platform", ["facebook", "mercari"]);
    expect(afterSharpen ?? []).toHaveLength(0);
  });

  it("advances the review revision atomically with dashboard seller edits", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "dashboard-revision");

    const dashboardEdit = await userA.client.rpc("update_dashboard_review", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_set_price_override: true,
      p_price_override: 199,
      p_set_cost_basis: true,
      p_cost_basis: 75,
      p_set_status: true,
      p_status: "archived",
    });
    expect(dashboardEdit.error).toBeNull();
    expect(dashboardEdit.data).not.toBe(seeded.reviewRevision);

    const [{ data: item }, { data: listing }] = await Promise.all([
      userA.client
        .from("items")
        .select("price_override, cost_basis, review_revision")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("status")
        .eq("id", seeded.listingId)
        .single(),
    ]);
    expect(Number(item?.price_override)).toBe(199);
    expect(Number(item?.cost_basis)).toBe(75);
    expect(item?.review_revision).toBe(dashboardEdit.data);
    expect(listing?.status).toBe("archived");

    const staleSave = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: crypto.randomUUID(),
      p_attributes: { category: "electronics", condition: "fair" },
      p_condition: "fair",
      p_price_override: 1,
      p_cost_basis: 1,
      p_listing_title: "Stale review title",
      p_listing_description: "Stale review description",
    });
    expect(staleSave.error?.code).toBe("P0002");

    await expect(
      commitCorrection(
        userA,
        commitFor(
          seeded.itemId,
          seeded.listingId,
          crypto.randomUUID(),
          seeded.reviewRevision,
        ),
      ),
    ).rejects.toThrow(/Review changed/i);

    const crossTenant = await userB.client.rpc("update_dashboard_review", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_set_price_override: true,
      p_price_override: 2,
      p_set_cost_basis: false,
      p_cost_basis: null,
      p_set_status: false,
      p_status: null,
    });
    expect(crossTenant.error?.code).toBe("P0002");

    const { data: preserved } = await userA.client
      .from("items")
      .select("price_override, cost_basis, review_revision")
      .eq("id", seeded.itemId)
      .single();
    expect(Number(preserved?.price_override)).toBe(199);
    expect(Number(preserved?.cost_basis)).toBe(75);
    expect(preserved?.review_revision).toBe(dashboardEdit.data);
  });

  it("recovers an expired publish lease without letting the stale owner finalize", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "expired-publish-lease");

    const first = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: originalRunIds.get(seeded.itemId),
      p_expected_review_revision: seeded.reviewRevision,
    });
    expect(first.error).toBeNull();
    expect(typeof first.data?.claimId).toBe("string");

    const overlapping = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: originalRunIds.get(seeded.itemId),
      p_expected_review_revision: seeded.reviewRevision,
    });
    expect(overlapping.error?.code).toBe("P0002");

    const { error: expireError } = await admin
      .from("listings")
      .update({
        ebay_publish_claimed_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      })
      .eq("id", seeded.listingId);
    expect(expireError).toBeNull();

    const recovered = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: originalRunIds.get(seeded.itemId),
      p_expected_review_revision: first.data.claimId as string,
    });
    expect(recovered.error).toBeNull();
    expect(recovered.data.claimId).not.toBe(first.data.claimId);

    const { data: staleFinalize, error: staleFinalizeError } = await userA.client
      .from("listings")
      .update({ ebay_status: "published" })
      .eq("id", seeded.listingId)
      .eq("ebay_publish_claim_id", first.data.claimId as string)
      .select("id");
    expect(staleFinalizeError).toBeNull();
    expect(staleFinalize ?? []).toHaveLength(0);

    const { data: current } = await userA.client
      .from("listings")
      .select("ebay_status, ebay_publish_claim_id")
      .eq("id", seeded.listingId)
      .single();
    expect(current?.ebay_status).toBe("publishing");
    expect(current?.ebay_publish_claim_id).toBe(recovered.data.claimId);
  });

  it("claims one seller price snapshot and rejects a concurrent price edit", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "publish-price-snapshot");
    const edited = await userA.client.rpc("update_dashboard_review", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_set_price_override: true,
      p_price_override: 199,
      p_set_cost_basis: false,
      p_cost_basis: null,
      p_set_status: false,
      p_status: null,
    });
    expect(edited.error).toBeNull();

    const claim = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: originalRunIds.get(seeded.itemId),
      p_expected_review_revision: edited.data,
    });
    expect(claim.error).toBeNull();
    expect(Number(claim.data?.priceOverride)).toBe(199);

    const concurrentEdit = await userA.client.rpc("update_dashboard_review", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_set_price_override: true,
      p_price_override: 222,
      p_set_cost_basis: false,
      p_cost_basis: null,
      p_set_status: false,
      p_status: null,
    });
    expect(concurrentEdit.error?.code).toBe("P0002");

    const { data: item } = await userA.client
      .from("items")
      .select("price_override")
      .eq("id", seeded.itemId)
      .single();
    expect(Number(item?.price_override)).toBe(199);
  });
});
