import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildPipelinePersistencePayload,
  type PipelineResult,
} from "@/lib/pipeline";
import {
  createSupabasePipelineWorkerStore,
  type PipelineAttemptAcquisition,
  type PipelineWorkerRpcClient,
} from "@/lib/pipeline-queue/worker-store";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { createSupabasePricingEvidenceReader } from "@/lib/pricing-evidence";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESULT: PipelineResult = {
  attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
  identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
  price: {
    suggested: 149,
    range: { min: 130, max: 170 },
    confidence: 0.8,
    sources: [],
    tier: "llm-only",
  },
  confidence: { score: 0.86, band: "high", autopilotEligible: true },
  listing: {
    platform: "ebay",
    title: "Sony WH-1000XM4 Headphones",
    description: "Used headphones in good condition.",
    fields: { itemSpecifics: { Brand: "Sony" } },
  },
  model: "offline-vision",
  listingModel: "offline-listing",
};

interface StagedRun {
  item_id: string;
  run_id: string;
  queue_message_id: string;
}

let reachable = false;
let admin: SupabaseClient;
let freeUser: ClerkTestUser;
let concurrentUser: ClerkTestUser;
let paidUser: ClerkTestUser;
let stateUser: ClerkTestUser;
let lifecycleUser: ClerkTestUser;
const queueMessageIds = new Set<string>();

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) return false;
  try {
    return (
      await fetch(`${SUPABASE_URL}/auth/v1/health`, {
        headers: { apikey: ANON_KEY },
        signal: AbortSignal.timeout(2_000),
      })
    ).ok;
  } catch {
    return false;
  }
}

function stageArgs(
  userId: string,
  keys: string[],
  source: "single" | "batch" = "single",
) {
  const batchId = crypto.randomUUID();
  return {
    p_batch_id: batchId,
    p_daily_limit: 1_000,
    p_entries: keys.map((key, index) => ({
      idempotency_key: key,
      source,
      autopilot_enabled: false,
      photo_paths: [`${userId}/ledger/${batchId}/${index}/front.jpg`],
      cost_basis: null,
    })),
    p_per_minute_limit: 1_000,
    p_user_id: userId,
  };
}

async function stage(
  userId: string,
  keys: string[],
  source: "single" | "batch" = "single",
): Promise<StagedRun[]> {
  const result = await admin.rpc("stage_pipeline_batch", stageArgs(userId, keys, source));
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data as Array<Omit<StagedRun, "queue_message_id"> & {
    queue_message_id: string | number;
  }>).map((row) => ({
    ...row,
    queue_message_id: String(row.queue_message_id),
  }));
  for (const row of rows) queueMessageIds.add(String(row.queue_message_id));
  return rows;
}

async function recordPeriod(input: {
  userId: string;
  periodKey: string;
  originalTransactionId?: string;
  start: Date;
  expires: Date;
  state?: "active" | "grace" | "billing_retry" | "expired" | "revoked" | "refunded" | "ambiguous";
  graceExpires?: Date | null;
  allowance: number;
  eventId?: string;
  eventCreated: Date;
}) {
  return admin.rpc("record_verified_storekit_ai_item_period", {
    p_allowance: input.allowance,
    p_event_created_at: input.eventCreated.toISOString(),
    p_event_id: input.eventId ?? crypto.randomUUID(),
    p_expires_date: input.expires.toISOString(),
    p_grace_expires_date: input.graceExpires?.toISOString() ?? null,
    p_original_transaction_id:
      input.originalTransactionId ?? `original-${input.userId}`,
    p_period_key: input.periodKey,
    p_period_start: input.start.toISOString(),
    p_state: input.state ?? "active",
    p_user_id: input.userId,
  });
}

function acquired(
  value: PipelineAttemptAcquisition,
): Extract<PipelineAttemptAcquisition, { kind: "acquired" }> {
  expect(value.kind).toBe("acquired");
  return value as Extract<PipelineAttemptAcquisition, { kind: "acquired" }>;
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [freeUser, concurrentUser, paidUser, stateUser, lifecycleUser] =
    await Promise.all([
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "credit_free"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "credit_concurrent"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "credit_paid"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "credit_state"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "credit_lifecycle"),
    ]);
});

afterAll(async () => {
  if (!reachable) return;
  await Promise.all(
    [...queueMessageIds].map((messageId) =>
      admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
    ),
  );
  await cleanupClerkTestUsers(admin, [
    freeUser.id,
    concurrentUser.id,
    paidUser.id,
    stateUser.id,
    lifecycleUser.id,
  ]);
});

describe("AI-item credit ledger DB/RLS boundary", () => {
  it("reserves the included run once, replays it, and isolates both ledger tables", async () => {
    if (!reachable) return;
    const args = stageArgs(freeUser.id, ["free-first"]);
    const first = await admin.rpc("stage_pipeline_batch", args);
    expect(first.error).toBeNull();
    const repeated = await admin.rpc("stage_pipeline_batch", args);
    expect(repeated.error).toBeNull();
    const firstRows = first.data as StagedRun[];
    const repeatedRows = repeated.data as StagedRun[];
    queueMessageIds.add(String(firstRows[0].queue_message_id));
    expect(repeatedRows[0].run_id).toBe(firstRows[0].run_id);

    const [{ data: ownReservations }, { data: foreignReservations }] =
      await Promise.all([
        freeUser.client
          .from("ai_item_credit_reservations")
          .select("pipeline_run_id, state, logical_run_key, photo_set_fingerprint"),
        paidUser.client
          .from("ai_item_credit_reservations")
          .select("pipeline_run_id")
          .eq("pipeline_run_id", firstRows[0].run_id),
      ]);
    expect(ownReservations).toEqual([
      expect.objectContaining({
        pipeline_run_id: firstRows[0].run_id,
        state: "reserved",
        logical_run_key: "free-first",
        photo_set_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(foreignReservations).toEqual([]);

    const [{ data: ownPeriods }, { data: foreignPeriods }] = await Promise.all([
      freeUser.client
        .from("ai_item_allowance_periods")
        .select("source, period_key, allowance"),
      paidUser.client
        .from("ai_item_allowance_periods")
        .select("id")
        .eq("user_id", freeUser.id),
    ]);
    expect(ownPeriods).toEqual([
      { source: "included", period_key: "included-first-run", allowance: 1 },
    ]);
    expect(foreignPeriods).toEqual([]);
  });

  it("serializes concurrent first-run reservations so only one can consume the credit", async () => {
    if (!reachable) return;
    const [left, right] = await Promise.all([
      admin.rpc(
        "stage_pipeline_batch",
        stageArgs(concurrentUser.id, ["concurrent-left"]),
      ),
      admin.rpc(
        "stage_pipeline_batch",
        stageArgs(concurrentUser.id, ["concurrent-right"]),
      ),
    ]);
    const successes = [left, right].filter((result) => result.error === null);
    const failures = [left, right].filter((result) => result.error !== null);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error?.message).toMatch(/snaplist-pro-required/i);
    const rows = successes[0].data as StagedRun[];
    queueMessageIds.add(String(rows[0].queue_message_id));

    const { count } = await concurrentUser.client
      .from("ai_item_credit_reservations")
      .select("id", { count: "exact", head: true });
    expect(count).toBe(1);
  });

  it("uses a mid-period subscription for mixed entry points, preserves grace usage, and advances only on renewal", async () => {
    if (!reachable) return;
    const now = Date.now();
    const periodOneStart = new Date(now - 10 * 24 * 60 * 60 * 1_000);
    const periodOneExpires = new Date(now + 60 * 60 * 1_000);
    const periodOneEvent = new Date(now - 5_000);
    const periodOneEventId = crypto.randomUUID();
    const periodOne = await recordPeriod({
      userId: paidUser.id,
      periodKey: "paid-period-1",
      start: periodOneStart,
      expires: periodOneExpires,
      allowance: 2,
      eventId: periodOneEventId,
      eventCreated: periodOneEvent,
    });
    expect(periodOne).toMatchObject({ data: true, error: null });

    const included = (await stage(paidUser.id, ["paid-included"], "single"))[0];
    const paidBatch = await stage(
      paidUser.id,
      ["paid-batch-one", "paid-batch-two"],
      "batch",
    );
    expect(paidBatch).toHaveLength(2);

    const exhausted = await admin.rpc(
      "stage_pipeline_batch",
      stageArgs(paidUser.id, ["paid-exhausted"]),
    );
    expect(exhausted.error?.message).toMatch(/monthly-allowance-reached/i);

    const duplicate = await recordPeriod({
      userId: paidUser.id,
      periodKey: "paid-period-1",
      start: periodOneStart,
      expires: periodOneExpires,
      allowance: 2,
      eventId: periodOneEventId,
      eventCreated: periodOneEvent,
    });
    expect(duplicate).toMatchObject({ data: false, error: null });

    const grace = await recordPeriod({
      userId: paidUser.id,
      periodKey: "paid-period-1",
      start: periodOneStart,
      expires: periodOneExpires,
      state: "grace",
      graceExpires: new Date(now + 2 * 60 * 60 * 1_000),
      allowance: 2,
      eventCreated: new Date(now + 1_000),
    });
    expect(grace).toMatchObject({ data: true, error: null });
    const stillExhausted = await admin.rpc(
      "stage_pipeline_batch",
      stageArgs(paidUser.id, ["paid-grace-no-reset"]),
    );
    expect(stillExhausted.error?.message).toMatch(/monthly-allowance-reached/i);

    const periodTwoStart = new Date(now - 60_000);
    const periodTwo = await recordPeriod({
      userId: paidUser.id,
      periodKey: "paid-period-2",
      start: periodTwoStart,
      expires: new Date(now + 30 * 24 * 60 * 60 * 1_000),
      allowance: 2,
      eventCreated: new Date(now + 2_000),
    });
    expect(periodTwo).toMatchObject({ data: true, error: null });
    const renewalRuns = await stage(
      paidUser.id,
      ["renewal-one", "renewal-two"],
      "batch",
    );
    expect(renewalRuns).toHaveLength(2);

    const lateOlderPeriod = await recordPeriod({
      userId: paidUser.id,
      periodKey: "paid-period-0-late",
      start: new Date(now - 40 * 24 * 60 * 60 * 1_000),
      expires: new Date(now - 11 * 24 * 60 * 60 * 1_000),
      state: "expired",
      allowance: 99,
      eventCreated: new Date(now + 3_000),
    });
    expect(lateOlderPeriod).toMatchObject({ data: true, error: null });
    const afterLateCallback = await admin.rpc(
      "stage_pipeline_batch",
      stageArgs(paidUser.id, ["late-callback-must-not-reset"]),
    );
    expect(afterLateCallback.error?.message).toMatch(/monthly-allowance-reached/i);

    const { data: reservations } = await paidUser.client
      .from("ai_item_credit_reservations")
      .select("pipeline_run_id, allowance_period_id, photo_set_fingerprint")
      .order("reserved_at", { ascending: true });
    expect(reservations).toHaveLength(5);
    expect(new Set(reservations?.map((row) => row.photo_set_fingerprint)).size).toBe(5);
    expect(reservations?.[0].pipeline_run_id).toBe(included.run_id);
    expect(new Set(reservations?.slice(1, 3).map((row) => row.allowance_period_id)).size).toBe(1);
    expect(new Set(reservations?.slice(3).map((row) => row.allowance_period_id)).size).toBe(1);
    expect(reservations?.[1].allowance_period_id).not.toBe(
      reservations?.[3].allowance_period_id,
    );
  });

  it("fails closed on retry, expiration, revocation, refund, ambiguity and stale callbacks while honoring verified grace", async () => {
    if (!reachable) return;
    const now = Date.now();
    await stage(stateUser.id, ["state-included"]);
    const start = new Date(now - 24 * 60 * 60 * 1_000);
    const expires = new Date(now + 60 * 60 * 1_000);
    const originalTransactionId = "state-original";
    const active = await recordPeriod({
      userId: stateUser.id,
      periodKey: "state-period",
      originalTransactionId,
      start,
      expires,
      allowance: 10,
      eventCreated: new Date(now),
    });
    expect(active.error).toBeNull();

    const blockedStates = [
      "billing_retry",
      "expired",
      "ambiguous",
    ] as const;
    for (const [index, state] of blockedStates.entries()) {
      const update = await recordPeriod({
        userId: stateUser.id,
        periodKey: "state-period",
        originalTransactionId,
        start,
        expires,
        state,
        allowance: 10,
        eventCreated: new Date(now + (index + 1) * 1_000),
      });
      expect(update.error).toBeNull();
      const attempt = await admin.rpc(
        "stage_pipeline_batch",
        stageArgs(stateUser.id, [`state-${state}`]),
      );
      expect(attempt.error?.message).toMatch(/storekit-entitlement-unavailable/i);
    }

    const staleActive = await recordPeriod({
      userId: stateUser.id,
      periodKey: "state-period",
      originalTransactionId,
      start,
      expires,
      allowance: 10,
      eventCreated: new Date(now + 500),
    });
    expect(staleActive).toMatchObject({ data: false, error: null });

    const grace = await recordPeriod({
      userId: stateUser.id,
      periodKey: "state-period",
      originalTransactionId,
      start,
      expires,
      state: "grace",
      graceExpires: new Date(now + 2 * 60 * 60 * 1_000),
      allowance: 10,
      eventCreated: new Date(now + 10_000),
    });
    expect(grace).toMatchObject({ data: true, error: null });
    await expect(stage(stateUser.id, ["state-grace"])).resolves.toHaveLength(1);

    for (const [offset, state] of (["revoked", "refunded"] as const).entries()) {
      const terminal = await recordPeriod({
        userId: stateUser.id,
        periodKey: "state-period",
        originalTransactionId,
        start,
        expires,
        state,
        allowance: 10,
        eventCreated: new Date(now + (offset + 11) * 1_000),
      });
      expect(terminal.error).toBeNull();
      const attempt = await admin.rpc(
        "stage_pipeline_batch",
        stageArgs(stateUser.id, [`state-${state}`]),
      );
      expect(attempt.error?.message).toMatch(/storekit-entitlement-unavailable/i);
    }

    const terminalReopen = await recordPeriod({
      userId: stateUser.id,
      periodKey: "state-period",
      originalTransactionId,
      start,
      expires,
      allowance: 10,
      eventCreated: new Date(now + 20_000),
    });
    expect(terminalReopen.error?.message).toMatch(/cannot reopen/i);
  });

  it("keeps one reservation through retry, settles with exact draft evidence, restores terminal failure once, and reuses one guided correction", async () => {
    if (!reachable) return;
    const now = Date.now();
    const paidPeriod = await recordPeriod({
      userId: lifecycleUser.id,
      periodKey: "lifecycle-period",
      start: new Date(now - 60_000),
      expires: new Date(now + 30 * 24 * 60 * 60 * 1_000),
      allowance: 1,
      eventCreated: new Date(now),
    });
    expect(paidPeriod.error).toBeNull();

    const settledRun = (await stage(lifecycleUser.id, ["lifecycle-settle"]))[0];
    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    const firstAttempt = acquired(
      await store.acquire({
        runId: settledRun.run_id,
        messageId: settledRun.queue_message_id,
        leaseSeconds: 60,
      }),
    );
    await expect(
      store.failAttempt({
        runId: settledRun.run_id,
        leaseToken: firstAttempt.context.run.lease_token,
        retryable: true,
        retryAfterSeconds: 1,
        failureCode: "provider_timeout",
        safeFailureMessage: "SnapList will retry this listing.",
      }),
    ).resolves.toMatchObject({ status: "retrying" });
    const { data: reservedAfterRetry } = await lifecycleUser.client
      .from("ai_item_credit_reservations")
      .select("state")
      .eq("pipeline_run_id", settledRun.run_id)
      .single();
    expect(reservedAfterRetry?.state).toBe("reserved");

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const secondAttempt = acquired(
      await store.acquire({
        runId: settledRun.run_id,
        messageId: settledRun.queue_message_id,
        leaseSeconds: 60,
      }),
    );
    await store.checkpoint({
      runId: settledRun.run_id,
      leaseToken: secondAttempt.context.run.lease_token,
      stage: "generating",
      checkpoint: {
        identified: {
          attributes: RESULT.attributes,
          identification: RESULT.identification,
          model: RESULT.model,
        },
        priced: RESULT.price,
        generated: { copy: RESULT.listing, model: RESULT.listingModel! },
      },
      leaseSeconds: 60,
    });
    const completion = await store.complete({
      runId: settledRun.run_id,
      leaseToken: secondAttempt.context.run.lease_token,
      result: RESULT,
      autopilotEnabled: false,
    });

    const { data: settled } = await lifecycleUser.client
      .from("ai_item_credit_reservations")
      .select(
        "state, settled_review_revision, listing_id, prediction_log_id, restored_at",
      )
      .eq("pipeline_run_id", settledRun.run_id)
      .single();
    expect(settled).toMatchObject({
      state: "settled",
      listing_id: completion.listingId,
      restored_at: null,
      settled_review_revision: expect.stringMatching(/^[0-9a-f-]{36}$/),
      prediction_log_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const { data: listing } = await lifecycleUser.client
      .from("listings")
      .select("run_id, source_review_revision")
      .eq("id", completion.listingId)
      .single();
    expect(listing).toEqual({
      run_id: settledRun.run_id,
      source_review_revision: settled?.settled_review_revision,
    });
    await expect(
      store.complete({
        runId: settledRun.run_id,
        leaseToken: secondAttempt.context.run.lease_token,
        result: RESULT,
        autopilotEnabled: false,
      }),
    ).rejects.toThrow(/stale/i);

    const failedRun = (await stage(lifecycleUser.id, ["lifecycle-fail"]))[0];
    const failedAttempt = acquired(
      await store.acquire({
        runId: failedRun.run_id,
        messageId: failedRun.queue_message_id,
        leaseSeconds: 60,
      }),
    );
    await store.failAttempt({
      runId: failedRun.run_id,
      leaseToken: failedAttempt.context.run.lease_token,
      retryable: false,
      retryAfterSeconds: 1,
      failureCode: "invalid_pipeline_result",
      safeFailureMessage: "The generated listing did not pass validation.",
    });
    const { data: restored } = await lifecycleUser.client
      .from("ai_item_credit_reservations")
      .select("state, settled_at, restored_at")
      .eq("pipeline_run_id", failedRun.run_id)
      .single();
    expect(restored).toMatchObject({
      state: "restored",
      settled_at: null,
      restored_at: expect.any(String),
    });
    const incoherentRun = (
      await stage(lifecycleUser.id, ["lifecycle-after-restore"])
    )[0];
    const changedPhotos = await lifecycleUser.client
      .from("items")
      .update({
        photos: [`${lifecycleUser.id}/ledger/replacement/front.jpg`],
      })
      .eq("id", incoherentRun.item_id);
    expect(changedPhotos.error?.message).toMatch(/photo set is immutable/i);
    const incoherentAttempt = acquired(
      await store.acquire({
        runId: incoherentRun.run_id,
        messageId: incoherentRun.queue_message_id,
        leaseSeconds: 60,
      }),
    );
    await store.checkpoint({
      runId: incoherentRun.run_id,
      leaseToken: incoherentAttempt.context.run.lease_token,
      stage: "generating",
      checkpoint: {
        identified: {
          attributes: RESULT.attributes,
          identification: RESULT.identification,
          model: RESULT.model,
        },
        priced: RESULT.price,
        generated: { copy: RESULT.listing, model: RESULT.listingModel! },
      },
      leaseSeconds: 60,
    });
    const incompletePersistence = buildPipelinePersistencePayload(RESULT, false);
    incompletePersistence.item.identification = null;
    const incomplete = await admin.rpc("complete_pipeline_run", {
      p_lease_token: incoherentAttempt.context.run.lease_token,
      p_persistence: incompletePersistence,
      p_run_id: incoherentRun.run_id,
    });
    expect(incomplete.error?.message).toMatch(/coherent editable draft revision/i);
    const { data: stillReserved } = await lifecycleUser.client
      .from("ai_item_credit_reservations")
      .select("state")
      .eq("pipeline_run_id", incoherentRun.run_id)
      .single();
    expect(stillReserved?.state).toBe("reserved");
    await store.failAttempt({
      runId: incoherentRun.run_id,
      leaseToken: incoherentAttempt.context.run.lease_token,
      retryable: false,
      retryAfterSeconds: 1,
      failureCode: "incoherent_output",
      safeFailureMessage: "The generated listing did not pass validation.",
    });

    const firstAuthorization = await lifecycleUser.client.rpc(
      "authorize_ai_item_guided_correction",
      {
        p_item_id: settledRun.item_id,
        p_expected_review_revision: settled?.settled_review_revision,
      },
    );
    expect(firstAuthorization).toMatchObject({ data: true, error: null });
    const repeatedAuthorization = await lifecycleUser.client.rpc(
      "authorize_ai_item_guided_correction",
      {
        p_item_id: settledRun.item_id,
        p_expected_review_revision: settled?.settled_review_revision,
      },
    );
    expect(repeatedAuthorization).toMatchObject({ data: false, error: null });

    const editedRevision = crypto.randomUUID();
    const editAfterAuthorization = await lifecycleUser.client.rpc("save_review_edits", {
      p_item_id: settledRun.item_id,
      p_listing_id: completion.listingId,
      p_expected_review_revision: settled?.settled_review_revision,
      p_new_review_revision: editedRevision,
      p_attributes: RESULT.attributes,
      p_condition: "good",
      p_price_override: null,
      p_cost_basis: null,
      p_listing_title: "Seller edit before guided correction",
      p_listing_description: "The seller changed the review before model work committed.",
    });
    expect(editAfterAuthorization.error).toBeNull();
    const reboundAuthorization = await lifecycleUser.client.rpc(
      "authorize_ai_item_guided_correction",
      {
        p_item_id: settledRun.item_id,
        p_expected_review_revision: editedRevision,
      },
    );
    expect(reboundAuthorization).toMatchObject({ data: true, error: null });

    const correctedRunId = crypto.randomUUID();
    const correction = await lifecycleUser.client.rpc(
      "regenerate_review_listing_with_credit",
      {
        p_item_id: settledRun.item_id,
        p_listing_id: completion.listingId,
        p_run_id: correctedRunId,
        p_expected_run_id: settledRun.run_id,
        p_expected_review_revision: editedRevision,
        p_attributes: { ...RESULT.attributes, model: "WH-1000XM5" },
        p_condition: "good",
        p_identification: {
          label: "Sony WH-1000XM5",
          confident: true,
          evidence: 2,
        },
        p_listing_title: "Sony WH-1000XM5 Headphones",
        p_listing_description: "Corrected model in good used condition.",
        p_listing_copy: RESULT.listing.fields,
        p_price: 199,
        p_price_range: { min: 180, max: 220 },
        p_confidence: 0.85,
        p_tier_fired: "llm-only",
        p_model: "offline-vision",
        p_listing_model: "offline-listing",
        p_pricing_model: null,
        p_sources: [],
        p_autopilot_enabled: false,
        p_autopilot_eligible: true,
      },
    );
    expect(correction.error).toBeNull();
    const { data: correctedReservation } = await lifecycleUser.client
      .from("ai_item_credit_reservations")
      .select("state, guided_correction_revision, guided_correction_completed_at")
      .eq("pipeline_run_id", settledRun.run_id)
      .single();
    expect(correctedReservation).toMatchObject({
      state: "settled",
      guided_correction_revision: editedRevision,
      guided_correction_completed_at: expect.any(String),
    });
    const pricingReader = createSupabasePricingEvidenceReader(
      async () => lifecycleUser.client,
    );
    await expect(
      pricingReader.forItem({
        userId: lifecycleUser.id,
        bearerToken: "test",
        itemId: settledRun.item_id,
      }),
    ).rejects.toThrow(/coherent|run/i);
    const secondCorrection = await lifecycleUser.client.rpc(
      "authorize_ai_item_guided_correction",
      {
        p_item_id: settledRun.item_id,
        p_expected_review_revision: correctedRunId,
      },
    );
    expect(secondCorrection.error?.message).toMatch(/guided correction is unavailable/i);
  }, 20_000);
});
