import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
  mintVerifiedGuestJwt,
} from "@/lib/supabase/test-users";
import { canonicalizeVerifiedPhotoSet } from "@/lib/photo-identity/photo-set";
import {
  createSupabasePipelineWorkerStore,
  type PipelineAttemptAcquisition,
  type PipelineWorkerRpcClient,
} from "@/lib/pipeline-queue/worker-store";
import {
  createSupabaseGuidedCorrectionCompletionGateway,
  type GuidedCorrectionCompletionRpcClient,
} from "@/lib/pipeline/guided-correction-completion";
import type { PipelineResult } from "@/lib/pipeline";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
} from "@/test/exclusive-resource-lock";
import {
  createListingReviewSaveDataClient,
  createListingReviewSaver,
  listingReviewSaveIntentSchema,
  ListingReviewIdempotencyConflictError,
  ListingReviewNotEditableError,
  ListingReviewSaveInProgressError,
  ListingReviewStaleError,
  type ListingReviewSaveIntent,
  type ListingReviewSaveOperation,
} from "./save";

const migrationPath =
  "supabase/migrations/20260730060000_mobile_listing_review_save.sql";
const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = resolveLocalTestDatabaseUrl();

interface ReviewFixture {
  itemId: string;
  listingId: string;
  queueMessageId: string;
  reviewRevision: string;
  runId: string;
  userId: string;
}

const BASE_RESULT: PipelineResult = {
  attributes: {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "very-good",
    title: "Sony WH-1000XM4",
  },
  identification: {
    label: "Sony WH-1000XM4",
    confident: true,
    evidence: 0.9,
  },
  price: {
    suggested: 145,
    range: { min: 130, max: 160 },
    confidence: 0.72,
    sources: [],
    tier: "llm-only",
  },
  confidence: {
    score: 0.72,
    band: "medium",
    autopilotEligible: false,
  },
  listing: {
    platform: "ebay",
    title: "Sony WH-1000XM4 Noise-Canceling Headphones",
    description: "Clean, fully working headphones with case and charging cable.",
    fields: {
      itemSpecifics: {
        Brand: "Sony",
        Model: "WH-1000XM4",
      },
    },
  },
  model: "test-vision",
  listingModel: "test-listing",
};

async function stackReachable(): Promise<boolean> {
  if (!PUBLISHABLE_KEY || !SECRET_KEY) return false;
  try {
    return (
      await fetch(`${SUPABASE_URL}/auth/v1/health`, {
        headers: { apikey: PUBLISHABLE_KEY },
        signal: AbortSignal.timeout(2_000),
      })
    ).ok;
  } catch {
    return false;
  }
}

function rlsClient(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function seedReview(
  admin: SupabaseClient,
  userId: string,
  label: string,
): Promise<ReviewFixture> {
  const batchId = crypto.randomUUID();
  const idempotencyKey = `listing-review-save-${label}-${batchId}`;
  const staged = await admin.rpc("stage_pipeline_batch", {
    p_user_id: userId,
    p_batch_id: batchId,
    p_entries: [{
      idempotency_key: idempotencyKey,
      source: "single",
      autopilot_enabled: false,
      photo_paths: [`${userId}/items/${batchId}/front.jpg`],
      cost_basis: null,
    }],
    p_daily_limit: 10,
    p_per_minute_limit: 10,
    p_photo_identities: [{
      idempotency_key: idempotencyKey,
      photo_identity_kind: "content_sha256_set_v1",
      photo_identity_fingerprint: canonicalizeVerifiedPhotoSet([
        "a".repeat(64),
      ]).fingerprint,
    }],
  });
  if (staged.error) throw new Error(staged.error.message);
  const row = (staged.data as Array<{
    item_id: string;
    run_id: string;
    queue_message_id: string | number;
  }>)[0]!;
  const worker = createSupabasePipelineWorkerStore(
    admin as unknown as PipelineWorkerRpcClient,
  );
  const acquisition = await worker.acquire({
    runId: row.run_id,
    messageId: String(row.queue_message_id),
    leaseSeconds: 60,
  });
  if (acquisition.kind !== "acquired") {
    throw new Error(`Expected acquired review fixture, received ${acquisition.kind}`);
  }
  const attempt = acquisition as Extract<
    PipelineAttemptAcquisition,
    { kind: "acquired" }
  >;
  await worker.checkpoint({
    runId: row.run_id,
    leaseToken: attempt.context.run.lease_token,
    stage: "generating",
    checkpoint: {
      identified: {
        attributes: BASE_RESULT.attributes,
        identification: BASE_RESULT.identification!,
        model: BASE_RESULT.model,
      },
      priced: {
        result: BASE_RESULT.price,
        evidenceAsOf: new Date().toISOString(),
      },
      generated: {
        copy: BASE_RESULT.listing,
        model: BASE_RESULT.listingModel!,
      },
    },
    leaseSeconds: 60,
  });
  const completion = await worker.complete({
    runId: row.run_id,
    leaseToken: attempt.context.run.lease_token,
    result: BASE_RESULT,
    autopilotEnabled: false,
  });
  const reviewRevision = crypto.randomUUID();
  const owner = rlsClient(await mintUserJwt(userId));
  const saved = await owner.rpc("save_review_edits", {
    p_item_id: row.item_id,
    p_listing_id: completion.listingId,
    p_expected_review_revision: attempt.context.item.review_revision,
    p_new_review_revision: reviewRevision,
    p_attributes: BASE_RESULT.attributes,
    p_condition: BASE_RESULT.attributes.condition,
    p_price_override: 149.99,
    p_cost_basis: null,
    p_listing_title: BASE_RESULT.listing.title,
    p_listing_description: BASE_RESULT.listing.description,
  });
  if (saved.error) throw new Error(saved.error.message);
  return {
    itemId: row.item_id,
    listingId: completion.listingId,
    queueMessageId: String(row.queue_message_id),
    reviewRevision,
    runId: row.run_id,
    userId,
  };
}

function rpcArguments(
  fixture: ReviewFixture,
  key: string,
  intent: ListingReviewSaveIntent,
) {
  return {
    p_run_id: fixture.runId,
    p_idempotency_key: key,
    p_expected_review_revision: intent.expectedReviewRevision,
    p_title: intent.title,
    p_description: intent.description,
    p_condition: intent.condition,
    p_specifics: intent.specifics,
    p_price_override: intent.sellerPriceOverride,
  };
}

function directOperation(
  operation: ListingReviewSaveOperation,
): ListingReviewSaveOperation {
  return {
    ...operation,
    intent: listingReviewSaveIntentSchema.parse(operation.intent),
  };
}

async function durableState(
  database: Client,
  fixture: ReviewFixture,
): Promise<unknown> {
  const result = await database.query<{ state: unknown }>(
    `select jsonb_build_object(
       'item', jsonb_build_object(
         'reviewRevision', item.review_revision,
         'reviewContentRevision', item.review_content_revision,
         'condition', item.condition,
         'attributes', item.attributes,
         'priceOverride', item.price_override
       ),
       'listing', jsonb_build_object(
         'title', listing.title,
         'description', listing.description,
         'copy', listing.copy,
         'sourceReviewRevision', listing.source_review_revision,
         'status', listing.status,
         'ebayListingId', listing.ebay_listing_id,
         'ebayStatus', listing.ebay_status
       ),
       'saves', coalesce((
         select jsonb_agg(
           jsonb_build_object(
             'key', save.idempotency_key,
             'runId', save.run_id,
             'expectedReviewRevision', save.expected_review_revision,
             'intent', save.intent,
             'state', save.state,
             'leaseExpiresAt', save.lease_expires_at,
             'receipt', save.receipt
           )
           order by save.idempotency_key
         )
         from private.mobile_listing_review_saves save
         where save.user_id = $1
       ), '[]'::jsonb)
     ) as state
     from public.items item
     join public.listings listing
       on listing.id = $3::uuid
      and listing.item_id = item.id
     where item.id = $2::uuid`,
    [fixture.userId, fixture.itemId, fixture.listingId],
  );
  return result.rows[0]?.state;
}

async function completeMockedCorrection(input: {
  admin: SupabaseClient;
  fixture: ReviewFixture;
  owner: SupabaseClient;
  key: string;
  expectedReviewRevision: string;
}): Promise<void> {
  const gateway = createSupabaseGuidedCorrectionCompletionGateway(
    input.owner,
    input.admin as unknown as GuidedCorrectionCompletionRpcClient,
  );
  const capability = await gateway.authorize({
    itemId: input.fixture.itemId,
    listingId: input.fixture.listingId,
    runId: input.key,
    expectedRunId: input.fixture.runId,
    expectedReviewRevision: input.expectedReviewRevision,
  });
  await gateway.complete({
    capabilityToken: capability.token,
    itemId: input.fixture.itemId,
    listingId: input.fixture.listingId,
    runId: input.key,
    expectedRunId: input.fixture.runId,
    expectedReviewRevision: input.expectedReviewRevision,
    result: {
      ...BASE_RESULT,
      attributes: {
        ...BASE_RESULT.attributes,
        model: "WH-1000XM5",
        condition: "good",
        title: "Sony WH-1000XM5",
      },
      identification: {
        label: "Sony WH-1000XM5",
        confident: true,
        evidence: 1,
      },
      price: {
        suggested: 199,
        range: { min: 180, max: 220 },
        confidence: 0.85,
        sources: [],
        tier: "llm-only",
      },
      confidence: {
        score: 0.85,
        band: "high",
        autopilotEligible: false,
      },
      listing: {
        ...BASE_RESULT.listing,
        title: "Generated Sony WH-1000XM5",
        description: "Generated coherent correction copy.",
        fields: {
          itemSpecifics: {
            Brand: "Sony",
            Model: "WH-1000XM5",
          },
        },
      },
    },
  });
}

describe("mobile Listing Review save RLS authority", () => {
  it("keeps the ordinary domain write security-invoker and run-derived", () => {
    const migration = readFileSync(migrationPath, "utf8");

    const ordinarySave = migration.match(
      /create or replace function public\.save_mobile_listing_review\([\s\S]*?\n\$\$;/i,
    )?.[0];
    const privateClaim = migration.match(
      /create or replace function public\.claim_mobile_listing_review_save\([\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(ordinarySave).toBeDefined();
    expect(privateClaim).toBeDefined();
    expect(privateClaim).toMatch(/security definer/i);
    expect(privateClaim).toMatch(
      /from public\.pipeline_runs run[\s\S]*?for update;/i,
    );
    expect(privateClaim).toMatch(
      /from public\.items item[\s\S]*?for update;/i,
    );
    expect(privateClaim).toMatch(
      /from public\.listings listing[\s\S]*?for update;/i,
    );
    expect(ordinarySave).toMatch(/security invoker/i);
    expect(ordinarySave).not.toMatch(/security definer/i);
    expect(ordinarySave).not.toMatch(/\bfor update\b/i);
    expect(ordinarySave).toMatch(
      /from public\.pipeline_runs run[\s\S]*run\.id = p_run_id[\s\S]*run\.user_id = public\.clerk_user_id\(\)/i,
    );
    expect(ordinarySave).toMatch(
      /perform public\.save_review_edits\([\s\S]*v_expected_revision[\s\S]*p_idempotency_key/i,
    );
    expect(ordinarySave).toMatch(
      /source_review_revision = p_idempotency_key/i,
    );
    expect(migration).toMatch(
      /v_listing\.copy #> '\{itemSpecifics\}'/i,
    );
    expect(ordinarySave).toMatch(
      /v_copy := jsonb_set\([\s\S]*coalesce\(v_listing\.copy, '\{\}'::jsonb\),[\s\S]*'\{itemSpecifics\}',[\s\S]*v_specifics/i,
    );
    expect(migration).not.toMatch(/\{fields,itemSpecifics\}/i);
    expect(migration).not.toMatch(
      /grant\s+update\s+on(?:\s+table)?\s+public\.(?:pipeline_runs|items|listings)[\s\S]*authenticated/i,
    );
  });

  it("keeps replay receipts private and grants only fixed RPCs", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(
      /create table private\.mobile_listing_review_saves/i,
    );
    expect(migration).toMatch(
      /revoke all on table private\.mobile_listing_review_saves\s+from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.save_mobile_listing_review[\s\S]*to authenticated/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.claim_mobile_listing_review_save\([\s\S]*from public, anon, service_role/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.save_mobile_listing_review\([\s\S]*from public, anon, service_role/i,
    );
  });

  it("routes every staged specifics change through coherent regeneration", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(
      /v_normalized_current_specifics is distinct from v_requested_specifics/i,
    );
    expect(migration).toMatch(
      /'snapshot', jsonb_build_object\([\s\S]*'specifics', v_current_specifics/i,
    );
    expect(migration).not.toMatch(
      /where lower\(btrim\(entry\.value->>'name'\)\) in \(\s*'brand', 'model', 'category', 'isbn', 'upc'/i,
    );
  });

  it("returns a completed receipt before applying current editability guards", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const privateClaim = migration.match(
      /create or replace function public\.claim_mobile_listing_review_save\([\s\S]*?\n\$\$;/i,
    )?.[0];

    expect(privateClaim).toBeDefined();
    expect(privateClaim).toMatch(
      /select save\.\* into v_save[\s\S]*v_save_found := found;[\s\S]*if p_action = 'prepare' and v_save_found and v_save\.state = 'completed' then[\s\S]*return jsonb_build_object\('state', 'completed', 'receipt', v_save\.receipt\);[\s\S]*if v_listing\.status is not distinct from 'published'/i,
    );
  });

  it("leases pending regeneration so a crashed request can be reclaimed", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/lease_expires_at timestamptz/i);
    expect(migration).toMatch(
      /v_save\.state = 'pending'[\s\S]*v_save\.lease_expires_at > statement_timestamp\(\)[\s\S]*return jsonb_build_object\('state', 'in_progress'\)/i,
    );
    expect(migration).toMatch(
      /set state = 'pending',[\s\S]*lease_expires_at = statement_timestamp\(\) \+ interval '5 minutes'/i,
    );
    expect(migration).toMatch(
      /set state = 'completed',[\s\S]*lease_expires_at = null,[\s\S]*receipt = v_receipt/i,
    );
    expect(migration).toMatch(
      /v_mode = 'regeneration'[\s\S]*from private\.mobile_listing_review_saves competing[\s\S]*competing\.run_id = p_run_id[\s\S]*competing\.expected_review_revision = p_expected_review_revision[\s\S]*competing\.idempotency_key is distinct from p_idempotency_key[\s\S]*competing\.state = 'pending'[\s\S]*competing\.lease_expires_at > statement_timestamp\(\)[\s\S]*return jsonb_build_object\('state', 'in_progress'\)/i,
    );
  });

  it("cent-normalizes direct RPC fixture intent before database access", () => {
    expect(
      directOperation({
        runId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        intent: {
          expectedReviewRevision: crypto.randomUUID(),
          title: "Seller title",
          description: "Seller description.",
          condition: "good",
          specifics: [],
          sellerPriceOverride: 179.995,
        },
        userId: "user_test_review_save_direct",
        bearerToken: "test-token",
      }).intent.sellerPriceOverride,
    ).toBe(180);

    const selectorSource = readFileSync(
      "src/lib/listing-review/save.rls.test.ts",
      "utf8",
    );
    const normalizedReleaseCall = [
      "dataClient",
      "release(directOperation(crashedOperation))",
    ].join(".");
    expect(selectorSource).toContain(normalizedReleaseCall);
  });

  it("proves Clerk and Guest save parity through the fixed RPC transaction", async () => {
    if (!(await stackReachable())) return;
    const lease = await acquireExclusiveTestResource(
      "snaplist-local-supabase-listing-review-save",
    );
    const admin = createClient(SUPABASE_URL, SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const database = new Client({ connectionString: DATABASE_URL });
    const userIds: string[] = [];
    const fixtures: ReviewFixture[] = [];
    await database.connect();
    try {
      for (const principalKind of ["ClerkBearer", "GuestBearer"] as const) {
        const ownerId = `user_test_review_save_${principalKind}_${crypto.randomUUID()}`;
        const foreignId = `user_test_review_save_foreign_${principalKind}_${crypto.randomUUID()}`;
        userIds.push(ownerId, foreignId);
        const [ownerToken, foreignToken] =
          principalKind === "ClerkBearer"
            ? await Promise.all([
                mintUserJwt(ownerId),
                mintUserJwt(foreignId),
              ])
            : await Promise.all([
                mintVerifiedGuestJwt(ownerId, crypto.randomUUID()),
                mintVerifiedGuestJwt(foreignId, crypto.randomUUID()),
              ]);
        const owner = rlsClient(ownerToken);
        const foreign = rlsClient(foreignToken);
        const fixture = await seedReview(
          admin,
          ownerId,
          principalKind.toLowerCase(),
        );
        fixtures.push(fixture);
        const dataClient = createListingReviewSaveDataClient(() => owner);
        const saver = createListingReviewSaver(dataClient, {
          async regenerate() {
            throw new Error("Ordinary save unexpectedly requested regeneration.");
          },
        });
        const baseIntent: ListingReviewSaveIntent = {
          expectedReviewRevision: fixture.reviewRevision,
          title: "  Seller Sony WH-1000XM4  ",
          description: "  Seller-reviewed copy.  ",
          condition: "very-good",
          specifics: [
            { name: " Brand ", value: " Sony " },
            { name: "Model", value: " WH-1000XM4 " },
          ],
          sellerPriceOverride: 179.995,
        };
        const normalizedBaseIntent: ListingReviewSaveIntent = {
          ...baseIntent,
          title: baseIntent.title.trim(),
          description: baseIntent.description.trim(),
          specifics: baseIntent.specifics.map(({ name, value }) => ({
            name: name.trim(),
            value: value.trim(),
          })),
          sellerPriceOverride: 180,
        };

        const beforeForeign = await durableState(database, fixture);
        const foreignSave = await foreign.rpc(
          "save_mobile_listing_review",
          rpcArguments(fixture, crypto.randomUUID(), normalizedBaseIntent),
        );
        expect(foreignSave.error?.code).toBe("P0002");
        expect(await durableState(database, fixture)).toEqual(beforeForeign);

        const staleIntent = {
          ...baseIntent,
          expectedReviewRevision: crypto.randomUUID(),
        };
        const staleState = await durableState(database, fixture);
        await expect(
          saver.save({
            runId: fixture.runId,
            idempotencyKey: crypto.randomUUID(),
            intent: staleIntent,
            userId: ownerId,
            bearerToken: ownerToken,
          }),
        ).rejects.toBeInstanceOf(ListingReviewStaleError);
        expect(await durableState(database, fixture)).toEqual(staleState);

        const ordinaryKey = crypto.randomUUID();
        const ordinaryOperation = {
          runId: fixture.runId,
          idempotencyKey: ordinaryKey,
          intent: baseIntent,
          userId: ownerId,
          bearerToken: ownerToken,
        };
        const firstReceipt = await saver.save(ordinaryOperation);
        const firstState = await durableState(database, fixture);
        const replayReceipt = await saver.save({
          ...ordinaryOperation,
          intent: normalizedBaseIntent,
        });
        expect(replayReceipt).toEqual(firstReceipt);
        expect(replayReceipt.reviewRevision).toBe(ordinaryKey);
        expect(await durableState(database, fixture)).toEqual(firstState);
        expect(JSON.stringify(firstState)).toContain(ordinaryKey);

        await expect(
          saver.save({
            ...ordinaryOperation,
            intent: {
              ...baseIntent,
              title: "Different seller intent",
            },
          }),
        ).rejects.toBeInstanceOf(ListingReviewIdempotencyConflictError);
        expect(await durableState(database, fixture)).toEqual(firstState);

        const responseLossKey = crypto.randomUUID();
        const responseLossOperation: ListingReviewSaveOperation = {
          ...ordinaryOperation,
          idempotencyKey: responseLossKey,
          intent: {
            ...baseIntent,
            expectedReviewRevision: ordinaryKey,
            title: "Response-loss seller title",
          },
        };
        const lostResponse = await dataClient.execute(
          directOperation(responseLossOperation),
        );
        expect(lostResponse.state).toBe("completed");
        const recoveredReceipt = await saver.save(responseLossOperation);
        expect(lostResponse).toEqual({
          state: "completed",
          receipt: recoveredReceipt,
        });

        const activeRegenerationKey = crypto.randomUUID();
        const competingRegenerationKey = crypto.randomUUID();
        const competingIntent: ListingReviewSaveIntent = {
          ...baseIntent,
          expectedReviewRevision: responseLossKey,
          specifics: [
            ...baseIntent.specifics,
            { name: "Storage Capacity", value: "512 GB" },
          ],
        };
        const activeRegenerationOperation: ListingReviewSaveOperation = {
          ...ordinaryOperation,
          idempotencyKey: activeRegenerationKey,
          intent: competingIntent,
        };
        await expect(
          dataClient.execute(directOperation(activeRegenerationOperation)),
        ).resolves.toMatchObject({
          state: "regeneration",
          snapshot: { itemId: fixture.itemId },
        });
        const losingProviderWork = vi.fn();
        const competingSaver = createListingReviewSaver(dataClient, {
          regenerate: losingProviderWork,
        });
        await expect(
          competingSaver.save({
            ...activeRegenerationOperation,
            idempotencyKey: competingRegenerationKey,
          }),
        ).rejects.toBeInstanceOf(ListingReviewSaveInProgressError);
        expect(losingProviderWork).not.toHaveBeenCalled();
        const competingState = JSON.stringify(
          await durableState(database, fixture),
        );
        expect(competingState).toContain(activeRegenerationKey);
        expect(competingState).not.toContain(competingRegenerationKey);
        await dataClient.release(
          directOperation(activeRegenerationOperation),
        );

        for (const authoritative of [
          { ebay_status: "publishing" },
          {
            ebay_listing_id: `v1|${crypto.randomUUID()}|0`,
            ebay_status: "published",
          },
        ]) {
          const armed = await admin
            .from("listings")
            .update(authoritative)
            .eq("id", fixture.listingId);
          expect(armed.error).toBeNull();
          const authoritativeState = await durableState(database, fixture);
          await expect(
            saver.save(ordinaryOperation),
          ).resolves.toEqual(firstReceipt);
          await expect(
            saver.save({
              ...ordinaryOperation,
              idempotencyKey: crypto.randomUUID(),
              intent: {
                ...baseIntent,
                expectedReviewRevision: responseLossKey,
              },
            }),
          ).rejects.toBeInstanceOf(ListingReviewNotEditableError);
          expect(await durableState(database, fixture)).toEqual(
            authoritativeState,
          );
          const restored = await admin
            .from("listings")
            .update({
              ebay_listing_id: null,
              ebay_status: null,
            })
            .eq("id", fixture.listingId);
          expect(restored.error).toBeNull();
        }

        const crashedKey = crypto.randomUUID();
        const crashedIntent: ListingReviewSaveIntent = {
          ...baseIntent,
          expectedReviewRevision: responseLossKey,
          specifics: [
            ...baseIntent.specifics,
            { name: "Storage Capacity", value: "256 GB" },
          ],
        };
        const crashedOperation: ListingReviewSaveOperation = {
          ...ordinaryOperation,
          idempotencyKey: crashedKey,
          intent: crashedIntent,
        };
        await expect(
          dataClient.execute(directOperation(crashedOperation)),
        ).resolves.toMatchObject({
          state: "regeneration",
          snapshot: {
            itemId: fixture.itemId,
            specifics: {
              Brand: "Sony",
              Model: "WH-1000XM4",
            },
          },
        });
        await expect(
          dataClient.execute(directOperation(crashedOperation)),
        ).resolves.toEqual({ state: "in_progress" });
        await database.query(
          `update private.mobile_listing_review_saves
           set lease_expires_at = statement_timestamp() - interval '1 second'
           where user_id = $1
             and idempotency_key = $2::uuid`,
          [fixture.userId, crashedKey],
        );
        await expect(
          dataClient.execute(directOperation(crashedOperation)),
        ).resolves.toMatchObject({
          state: "regeneration",
          snapshot: { itemId: fixture.itemId },
        });
        await dataClient.release(directOperation(crashedOperation));

        const regenerationKey = crypto.randomUUID();
        const regenerationIntent: ListingReviewSaveIntent = {
          expectedReviewRevision: responseLossKey,
          title: "Staged Sony WH-1000XM5",
          description: "Staged seller copy wins after coherent regeneration.",
          condition: "good",
          specifics: [
            { name: "Brand", value: "Sony" },
            { name: "Model", value: "WH-1000XM5" },
            { name: "Color", value: "Black" },
          ],
          sellerPriceOverride: 210,
        };
        const regenerationOperation: ListingReviewSaveOperation = {
          runId: fixture.runId,
          idempotencyKey: regenerationKey,
          intent: regenerationIntent,
          userId: ownerId,
          bearerToken: ownerToken,
        };
        await expect(
          dataClient.execute(directOperation(regenerationOperation)),
        ).resolves.toMatchObject({
          state: "regeneration",
          snapshot: { itemId: fixture.itemId },
        });
        const pendingState = await durableState(database, fixture);
        const staleFinalize = await owner.rpc(
          "claim_mobile_listing_review_save",
          {
            p_action: "complete",
            ...rpcArguments(
              fixture,
              regenerationKey,
              regenerationIntent,
            ),
          },
        );
        expect(staleFinalize.error?.code).toBe("P0002");
        const foreignFinalize = await foreign.rpc(
          "claim_mobile_listing_review_save",
          {
            p_action: "complete",
            ...rpcArguments(
              fixture,
              regenerationKey,
              regenerationIntent,
            ),
          },
        );
        expect(foreignFinalize.error?.code).toBe("P0002");
        expect(await durableState(database, fixture)).toEqual(pendingState);

        await completeMockedCorrection({
          admin,
          fixture,
          owner,
          key: regenerationKey,
          expectedReviewRevision: responseLossKey,
        });
        const finalized = await dataClient.execute(
          directOperation(regenerationOperation),
        );
        expect(finalized).toMatchObject({
          state: "completed",
          receipt: {
            runId: fixture.runId,
            itemId: fixture.itemId,
            listingId: fixture.listingId,
            reviewRevision: regenerationKey,
          },
        });
        await expect(
          dataClient.execute(directOperation(regenerationOperation)),
        ).resolves.toEqual(finalized);
        const coherent = await database.query<{
          condition: string;
          description: string;
          model: string;
          review_revision: string;
          source_review_revision: string;
          title: string;
        }>(
          `select item.condition,
                  item.attributes->>'model' as model,
                  item.review_revision::text,
                  listing.title,
                  listing.description,
                  listing.source_review_revision::text
           from public.items item
           join public.listings listing
             on listing.id = $2::uuid
            and listing.item_id = item.id
           where item.id = $1::uuid`,
          [fixture.itemId, fixture.listingId],
        );
        expect(coherent.rows[0]).toEqual({
          condition: "good",
          description:
            "Staged seller copy wins after coherent regeneration.",
          model: "WH-1000XM5",
          review_revision: regenerationKey,
          source_review_revision: regenerationKey,
          title: "Staged Sony WH-1000XM5",
        });
      }
    } finally {
      await Promise.all(
        fixtures.map((fixture) =>
          admin.rpc("ack_pipeline_message", {
            p_message_id: fixture.queueMessageId,
          }),
        ),
      ).catch(() => undefined);
      await cleanupClerkTestUsers(admin, userIds);
      await database.end();
      await lease.release();
    }
  }, 60_000);
});
