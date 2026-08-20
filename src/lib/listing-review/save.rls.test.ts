import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import {
  cleanupClerkTestUsers,
  grantIncludedOfferDeviceClaim,
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
import { stackReachable } from "@/test/supabase-stack";
import {
  createListingReviewSaveDataClient,
  createListingReviewSaver,
  listingReviewSaveIntentSchema,
  ListingReviewIdempotencyConflictError,
  ListingReviewNotEditableError,
  ListingReviewSaveInProgressError,
  ListingReviewStaleError,
  type ListingReviewSaveDataClient,
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
  photoPath: string;
  queueMessageId: string;
  reviewRevision: string;
  runId: string;
  userId: string;
}

/**
 * What the pipeline actually writes into `copy.itemSpecifics`. `coreSpecifics` in
 * `src/lib/listing/generate.ts` emits the fixed literals Brand/Model/Type/Condition
 * whenever the item core carries them, so a listing that reaches Listing Review
 * ALWAYS mirrors the item condition into the specifics array.
 *
 * A fixture that omits Type/Condition cannot exercise the #919 scope gate at all:
 * condition would be the only field that moves, and the gate's specifics diff could
 * never disagree with it. Keep this production-shaped (#919 review round 1).
 */
function pipelineSpecifics(
  model: string,
  condition: string,
): Record<string, string> {
  return {
    Brand: "Sony",
    Model: model,
    Type: "electronics",
    Condition: condition,
  };
}

/**
 * What the seller's client hands back. `read.ts` projects every `copy.itemSpecifics`
 * entry into the draft and `ListingReviewClient.swift` echoes `draft.specifics`
 * verbatim, so a real save intent carries the mirrored Condition too — the intent
 * schema then rewrites that reserved entry to `intent.condition`.
 */
function sellerSpecifics(
  model: string,
  condition: string,
): Array<{ name: string; value: string }> {
  return Object.entries(pipelineSpecifics(model, condition)).map(
    ([name, value]) => ({ name, value }),
  );
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
      itemSpecifics: pipelineSpecifics("WH-1000XM4", "very-good"),
    },
  },
  model: "test-vision",
  listingModel: "test-listing",
};

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
  const photoPath = `${userId}/items/${batchId}/front.jpg`;
  // Listing Review save is downstream of the #524 device fence; the seed only
  // needs its tenant to be past it so the included first run can reserve.
  await grantIncludedOfferDeviceClaim(admin, userId);
  const staged = await admin.rpc("stage_pipeline_batch", {
    p_user_id: userId,
    p_batch_id: batchId,
    p_entries: [{
      idempotency_key: idempotencyKey,
      source: "single",
      autopilot_enabled: false,
      photo_paths: [photoPath],
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
    photoPath,
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

/**
 * `reruns` is the free condition-only regeneration count. Stating it on every
 * ledger assertion is the point: before #919 review round 1 the ledger could not
 * tell an unspent included correction with zero reruns from one with forty, and
 * the exemption removed the only cap those reruns had.
 */
const unspentIncludedCorrection = (reruns = 0) => [
  {
    condition_only_reruns: reruns,
    correction_spent: false,
    correction_started: false,
    state: "settled",
  },
];

const spentIncludedCorrection = (reruns = 0) => [
  {
    condition_only_reruns: reruns,
    correction_spent: true,
    correction_started: true,
    state: "settled",
  },
];

/**
 * The ledger row itself, not a convenience flag above it: #919 turns on whether
 * the seller's one included guided correction is still there afterwards.
 */
async function correctionLedger(
  database: Client,
  userId: string,
): Promise<unknown[]> {
  const result = await database.query(
    `select reservation.state,
            reservation.condition_only_reruns,
            reservation.guided_correction_started_at is not null
              as correction_started,
            reservation.guided_correction_completed_at is not null
              as correction_spent
     from public.ai_item_credit_reservations reservation
     where reservation.user_id = $1
     order by reservation.reserved_at`,
    [userId],
  );
  return result.rows;
}

async function savedPriceOverride(
  database: Client,
  itemId: string,
): Promise<string | null> {
  const result = await database.query<{ price_override: string | null }>(
    "select price_override::text from public.items where id = $1::uuid",
    [itemId],
  );
  return result.rows[0]?.price_override ?? null;
}

async function reviewState(
  database: Client,
  itemId: string,
): Promise<unknown> {
  const result = await database.query(
    `select item.attributes->>'model' as model,
            item.condition,
            item.price_override::text,
            item.review_revision::text
     from public.items item
     where item.id = $1::uuid`,
    [itemId],
  );
  return result.rows[0];
}

/** Records the state the database gate actually returned for each attempt. */
function observedDataClient(
  dataClient: ListingReviewSaveDataClient,
  states: string[],
): ListingReviewSaveDataClient {
  return {
    async execute(operation) {
      const result = await dataClient.execute(operation);
      states.push(result.state);
      return result;
    },
    release: (operation) => dataClient.release(operation),
  };
}

async function completeMockedCorrection(input: {
  admin: SupabaseClient;
  fixture: ReviewFixture;
  owner: SupabaseClient;
  key: string;
  expectedReviewRevision: string;
  expectedRunId?: string;
  correctedCondition?: string;
  correctedModel?: string;
}): Promise<void> {
  const condition = input.correctedCondition ?? "good";
  const model = input.correctedModel ?? "WH-1000XM5";
  const expectedRunId = input.expectedRunId ?? input.fixture.runId;
  const gateway = createSupabaseGuidedCorrectionCompletionGateway(
    input.owner,
    input.admin as unknown as GuidedCorrectionCompletionRpcClient,
  );
  const capability = await gateway.authorize({
    itemId: input.fixture.itemId,
    listingId: input.fixture.listingId,
    runId: input.key,
    expectedRunId,
    expectedReviewRevision: input.expectedReviewRevision,
  });
  await gateway.complete({
    capabilityToken: capability.token,
    itemId: input.fixture.itemId,
    listingId: input.fixture.listingId,
    runId: input.key,
    expectedRunId,
    expectedReviewRevision: input.expectedReviewRevision,
    result: {
      ...BASE_RESULT,
      attributes: {
        ...BASE_RESULT.attributes,
        model,
        condition,
        title: `Sony ${model}`,
      },
      identification: {
        label: `Sony ${model}`,
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
        title: `Generated Sony ${model}`,
        description: "Generated coherent correction copy.",
        fields: {
          itemSpecifics: pipelineSpecifics(model, condition),
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
    const pricingEvidenceGuard = migration.match(
      /create or replace function private\.prevent_pricing_evidence_snapshot_update\(\)[\s\S]*?\n\$\$;/i,
    )?.[0];
    const guestClaimTransfer = migration.match(
      /create or replace function private\.transfer_mobile_listing_review_saves_for_guest_claim\(\)[\s\S]*?\n\$\$;/i,
    )?.[0];

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
    const claimChildren = [
      {
        table: "private.mobile_item_submissions",
        constraints: [
          "mobile_item_submissions_item_owner_fkey",
          "mobile_item_submissions_run_owner_fkey",
        ],
        updatePattern:
          /update private\.mobile_item_submissions submission[\s\S]*set user_id = new\.user_id[\s\S]*submission\.item_id = old\.id[\s\S]*submission\.run_id = v_recovery\.pipeline_run_id[\s\S]*submission\.user_id = old\.user_id/i,
      },
      {
        table: "private.guided_correction_completion_capabilities",
        constraints: [
          "guided_correction_capability_reservation_fkey",
          "guided_correction_capability_listing_fkey",
        ],
        updatePattern:
          /update private\.guided_correction_completion_capabilities capability[\s\S]*set user_id = new\.user_id[\s\S]*capability\.item_id = old\.id[\s\S]*capability\.listing_id = v_recovery\.draft_id[\s\S]*capability\.reservation_id = v_recovery\.reservation_id[\s\S]*capability\.user_id = old\.user_id/i,
      },
      {
        table: "public.pricing_evidence_snapshots",
        constraints: [
          "pricing_evidence_snapshots_run_fkey",
          "pricing_evidence_snapshots_prediction_fkey",
          "pricing_evidence_snapshots_listing_fkey",
        ],
        updatePattern:
          /update public\.pricing_evidence_snapshots evidence[\s\S]*set user_id = new\.user_id[\s\S]*evidence\.user_id = old\.user_id[\s\S]*evidence\.item_id = old\.id[\s\S]*evidence\.pipeline_run_id = v_recovery\.pipeline_run_id[\s\S]*evidence\.listing_id = v_recovery\.draft_id/i,
      },
    ];
    for (const child of claimChildren) {
      const tablePattern = child.table.replace(".", "\\.");
      const alteration = migration.match(
        new RegExp(`alter table ${tablePattern}[\\s\\S]*?;`, "i"),
      )?.[0];
      for (const constraint of child.constraints) {
        expect(alteration ?? "").toMatch(
          new RegExp(
            `alter constraint ${constraint}\\s+deferrable initially immediate`,
            "i",
          ),
        );
        expect(guestClaimTransfer).toContain(
          `${child.table.split(".")[0]}.${constraint}`,
        );
      }
      expect(guestClaimTransfer).toMatch(child.updatePattern);
    }
    expect(guestClaimTransfer).toMatch(
      /current_setting\(\s*'snaplist\.guest_claim_recovery_id', true\s*\)[\s\S]*current_setting\(\s*'snaplist\.guest_claim_lease_token', true\s*\)[\s\S]*recovery\.item_id = old\.id[\s\S]*recovery\.guest_user_id = old\.user_id[\s\S]*recovery\.claim_target_user_id = new\.user_id[\s\S]*update private\.mobile_listing_review_saves[\s\S]*set user_id = new\.user_id[\s\S]*where run_id = v_recovery\.pipeline_run_id[\s\S]*and user_id = old\.user_id/i,
    );
    expect(migration).toMatch(
      /create trigger transfer_mobile_listing_review_saves_for_guest_claim[\s\S]*before update of user_id on public\.items[\s\S]*execute function private\.transfer_mobile_listing_review_saves_for_guest_claim\(\)/i,
    );
    expect(pricingEvidenceGuard).toMatch(
      /new\.user_id is distinct from old\.user_id/i,
    );
    for (const column of [
      "run_id",
      "pipeline_run_id",
      "run_kind",
      "item_id",
      "prediction_id",
      "listing_id",
      "schema_version",
      "item",
      "price_result",
      "evidence",
      "evidence_as_of",
    ]) {
      expect(pricingEvidenceGuard).toContain(
        `new.${column} is not distinct from old.${column}`,
      );
    }
    expect(pricingEvidenceGuard).toMatch(
      /current_setting\(\s*'snaplist\.guest_claim_recovery_id', true\s*\)[\s\S]*current_setting\(\s*'snaplist\.guest_claim_lease_token', true\s*\)[\s\S]*recovery\.guest_user_id = old\.user_id[\s\S]*recovery\.claim_target_user_id = new\.user_id[\s\S]*recovery\.draft_id = old\.listing_id[\s\S]*recovery\.state = 'copying'[\s\S]*recovery\.claim_lease_expires_at > statement_timestamp\(\)[\s\S]*if found then\s*return new;\s*end if;[\s\S]*errcode = '55000'[\s\S]*message = 'Pricing evidence snapshots are immutable'/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.prevent_pricing_evidence_snapshot_update\(\)\s+from public, anon, authenticated, service_role/i,
    );
  });

  it("routes every staged specifics change through coherent regeneration", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(
      /v_normalized_current_specifics is distinct from v_requested_specifics/i,
    );
    expect(migration).toMatch(
      /jsonb_array_length\(p_specifics\) = 0/i,
    );
    expect(migration).toMatch(
      /'snapshot', jsonb_build_object\([\s\S]*'title', v_listing\.title[\s\S]*'description', v_listing\.description[\s\S]*'specifics', v_current_specifics/i,
    );
    expect(migration).toMatch(
      /v_listing_title := case[\s\S]*v_state = 'finalize'[\s\S]*btrim\(p_title\) is not distinct from\s+v_claim #>> '\{snapshot,title\}'[\s\S]*then v_listing\.title[\s\S]*else btrim\(p_title\)[\s\S]*v_listing_description := case[\s\S]*btrim\(p_description\) is not distinct from\s+v_claim #>> '\{snapshot,description\}'[\s\S]*then v_listing\.description[\s\S]*else btrim\(p_description\)/i,
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
          specifics: [{ name: "Brand", value: "Sony" }],
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

  it("proves Clerk and Guest save parity through the fixed RPC transaction", async (context) => {
    const reachable = await stackReachable({
      url: SUPABASE_URL,
      apiKey: PUBLISHABLE_KEY,
      requiredValues: [PUBLISHABLE_KEY, SECRET_KEY],
    });
    if (!reachable) context.skip();
    const lease = await acquireExclusiveTestResource(
      "snaplist-local-supabase-listing-review-save",
    );
    const admin = createClient(SUPABASE_URL, SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const database = new Client({ connectionString: DATABASE_URL });
    const userIds: string[] = [];
    const fixtures: ReviewFixture[] = [];
    const recoveryIds: string[] = [];
    const claimedStoragePaths: string[] = [];
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
            { name: " Type ", value: " electronics " },
            { name: "Condition", value: " very-good " },
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
        const emptySpecifics = await owner.rpc(
          "save_mobile_listing_review",
          {
            ...rpcArguments(
              fixture,
              crypto.randomUUID(),
              normalizedBaseIntent,
            ),
            p_specifics: [],
          },
        );
        expect(emptySpecifics.error?.code).toBe("22023");
        expect(await durableState(database, fixture)).toEqual(beforeForeign);

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

        const unchangedFixture = await seedReview(
          admin,
          foreignId,
          `${principalKind.toLowerCase()}-unchanged-copy`,
        );
        fixtures.push(unchangedFixture);
        const unchangedDataClient = createListingReviewSaveDataClient(
          () => foreign,
        );
        const unchangedCopyKey = crypto.randomUUID();
        const unchangedCopyIntent: ListingReviewSaveIntent = {
          expectedReviewRevision: unchangedFixture.reviewRevision,
          title: BASE_RESULT.listing.title,
          description: BASE_RESULT.listing.description,
          condition: "good",
          specifics: sellerSpecifics("WH-1000XM5", "good"),
          sellerPriceOverride: 220,
        };
        const unchangedProviderWork = vi.fn(async () => {
          await completeMockedCorrection({
            admin,
            fixture: unchangedFixture,
            owner: foreign,
            key: unchangedCopyKey,
            expectedReviewRevision: unchangedFixture.reviewRevision,
          });
        });
        const unchangedCopySaver = createListingReviewSaver(
          unchangedDataClient,
          { regenerate: unchangedProviderWork },
        );
        const unchangedCopyReceipt = await unchangedCopySaver.save({
          runId: unchangedFixture.runId,
          idempotencyKey: unchangedCopyKey,
          intent: unchangedCopyIntent,
          userId: foreignId,
          bearerToken: foreignToken,
        });
        expect(unchangedCopyReceipt.reviewRevision).toBe(unchangedCopyKey);
        expect(unchangedProviderWork).toHaveBeenCalledOnce();
        const unchangedCopy = await database.query<{
          description: string;
          model: string;
          review_revision: string;
          title: string;
        }>(
          `select item.attributes->>'model' as model,
                  item.review_revision::text,
                  listing.title,
                  listing.description
           from public.items item
           join public.listings listing
             on listing.id = $2::uuid
            and listing.item_id = item.id
           where item.id = $1::uuid`,
          [unchangedFixture.itemId, unchangedFixture.listingId],
        );
        expect(unchangedCopy.rows[0]).toEqual({
          description: "Generated coherent correction copy.",
          model: "WH-1000XM5",
          review_revision: unchangedCopyKey,
          title: "Generated Sony WH-1000XM5",
        });

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
            ...sellerSpecifics("WH-1000XM5", "good"),
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

        if (principalKind === "GuestBearer") {
          const accountId =
            `user_test_review_save_claim_${crypto.randomUUID()}`;
          const accountToken = await mintUserJwt(accountId);
          userIds.push(accountId);
          const recoveryId = crypto.randomUUID();
          recoveryIds.push(recoveryId);
          const recoveryTokenHash = "b".repeat(64);
          const registered = await admin.rpc("register_guest_draft_recovery", {
            p_recovery_id: recoveryId,
            p_guest_user_id: ownerId,
            p_pipeline_run_id: fixture.runId,
            p_recovery_token_hash: recoveryTokenHash,
            p_encrypted_artifact: {
              version: 1,
              algorithm: "aes-256-gcm",
              keyId: "listing-review-claim-test",
              keyEnvelope: Buffer.alloc(1, 1).toString("base64"),
              nonce: Buffer.alloc(12, 2).toString("base64"),
              tag: Buffer.alloc(16, 3).toString("base64"),
              ciphertext: Buffer.from("encrypted-review").toString("base64"),
            },
            p_storage_manifest: [{
              sourcePath: fixture.photoPath,
              sha256: "a".repeat(64),
              byteLength: 1,
              encryption: {
                algorithm: "aes-256-gcm",
                keyId: "listing-review-claim-test",
                nonce: Buffer.alloc(12, 4).toString("base64"),
                tag: Buffer.alloc(16, 5).toString("base64"),
              },
            }],
          });
          expect(registered.error).toBeNull();
          expect(registered.data).toMatchObject({ outcome: "recoverable" });

          const completionToken = randomBytes(32).toString("hex");
          const completionTokenHash = createHash("sha256")
            .update(completionToken)
            .digest("hex");
          const claimStarted = await admin.rpc(
            "begin_guest_draft_claim_with_plaintext",
            {
            p_recovery_id: recoveryId,
            p_guest_user_id: ownerId,
            p_recovery_token_hash: recoveryTokenHash,
            p_target_user_id: accountId,
            p_idempotency_key: crypto.randomUUID(),
            p_claim_lease_seconds: 300,
              p_completion_token_hash: completionTokenHash,
            },
          );
          expect(claimStarted.error).toBeNull();
          const claimPlan = claimStarted.data as {
            claimLeaseToken: string;
            objects: Array<{
              byteLength: number;
              destinationPath: string;
              encryption: Record<string, unknown>;
              sha256: string;
              sourcePath: string;
            }>;
            outcome: string;
          };
          expect(claimPlan.outcome).toBe("copy_required");
          const claimedPlaintext = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
          const accountClient = rlsClient(accountToken);
          for (const object of claimPlan.objects) {
            const uploaded = await accountClient.storage
              .from("photos")
              .upload(object.destinationPath, claimedPlaintext, {
                contentType: "image/jpeg",
                upsert: false,
              });
            expect(uploaded.error).toBeNull();
            claimedStoragePaths.push(object.destinationPath);
          }

          const beforeClaim = await database.query<{
            review_revision: string;
          }>(
            "select review_revision::text from public.items where id = $1::uuid",
            [fixture.itemId],
          );
          const claimCompleted = await accountClient.rpc(
            "complete_guest_draft_claim_with_plaintext",
            {
              p_recovery_id: recoveryId,
              p_recovery_token_hash: recoveryTokenHash,
              p_target_user_id: accountId,
              p_claim_lease_token: claimPlan.claimLeaseToken,
              p_completion_token: completionToken,
              p_verified_objects: claimPlan.objects.map((object) => ({
                destinationPath: object.destinationPath,
                sourceByteLength: object.byteLength,
                sourceSha256: object.sha256,
                plaintextByteLength: claimedPlaintext.byteLength,
                plaintextSha256: createHash("sha256")
                  .update(claimedPlaintext)
                  .digest("hex"),
                mediaType: "image/jpeg",
              })),
            },
          );
          expect(claimCompleted.error).toBeNull();
          expect(claimCompleted.data).toMatchObject({ outcome: "claimed" });

          const claimedState = await database.query<{
            item_user_id: string;
            review_revision: string;
            run_user_id: string;
            save_users: string[];
          }>(
            `select item.user_id as item_user_id,
                    item.review_revision::text,
                    run.user_id as run_user_id,
                    array(
                      select distinct save.user_id
                      from private.mobile_listing_review_saves save
                      where save.run_id = run.id
                      order by save.user_id
                    ) as save_users
             from public.items item
             join public.pipeline_runs run
               on run.id = $2::uuid
              and run.item_id = item.id
             where item.id = $1::uuid`,
            [fixture.itemId, fixture.runId],
          );
          expect(claimedState.rows[0]).toEqual({
            item_user_id: accountId,
            review_revision: beforeClaim.rows[0]?.review_revision,
            run_user_id: accountId,
            save_users: [accountId],
          });

          const claimedProviderWork = vi.fn();
          const accountSaver = createListingReviewSaver(
            createListingReviewSaveDataClient(() => rlsClient(accountToken)),
            { regenerate: claimedProviderWork },
          );
          const claimedReplay = await accountSaver.save({
            ...responseLossOperation,
            userId: accountId,
            bearerToken: accountToken,
          });
          expect(claimedReplay).toEqual(recoveredReceipt);
          expect(claimedProviderWork).not.toHaveBeenCalled();
          const afterReplay = await database.query<{
            review_revision: string;
          }>(
            "select review_revision::text from public.items where id = $1::uuid",
            [fixture.itemId],
          );
          expect(afterReplay.rows[0]).toEqual(beforeClaim.rows[0]);
        }
      }
    } finally {
      if (claimedStoragePaths.length > 0) {
        await admin.storage.from("photos").remove(claimedStoragePaths);
      }
      if (recoveryIds.length > 0) {
        await database.query(
          "delete from private.pipeline_storage_cleanup_jobs where source_id = any($1::uuid[])",
          [recoveryIds],
        );
        await database.query(
          "delete from private.guest_draft_recoveries where id = any($1::uuid[])",
          [recoveryIds],
        );
      }
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

  it("reruns a condition-only correction free and still charges an identity edit", async (context) => {
    const reachable = await stackReachable({
      url: SUPABASE_URL,
      apiKey: PUBLISHABLE_KEY,
      requiredValues: [PUBLISHABLE_KEY, SECRET_KEY],
    });
    if (!reachable) context.skip();
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
      const conditionUserId = `user_test_review_condition_${crypto.randomUUID()}`;
      const identityUserId = `user_test_review_identity_${crypto.randomUUID()}`;
      const copyUserId = `user_test_review_copy_${crypto.randomUUID()}`;
      const desyncUserId = `user_test_review_desync_${crypto.randomUUID()}`;
      userIds.push(conditionUserId, identityUserId, copyUserId, desyncUserId);
      const [conditionToken, identityToken, copyToken, desyncToken] =
        await Promise.all([
          mintUserJwt(conditionUserId),
          mintUserJwt(identityUserId),
          mintUserJwt(copyUserId),
          mintUserJwt(desyncUserId),
        ]);

      // A declared-condition change is the seller supplying ground truth the
      // model guessed from photos. It reruns everything and spends nothing.
      const conditionFixture = await seedReview(
        admin,
        conditionUserId,
        "condition-only",
      );
      fixtures.push(conditionFixture);
      const conditionOwner = rlsClient(conditionToken);
      const conditionData = createListingReviewSaveDataClient(
        () => conditionOwner,
      );
      expect(await correctionLedger(database, conditionUserId)).toEqual(
        unspentIncludedCorrection(0),
      );

      const conditionKey = crypto.randomUUID();
      const conditionIntent: ListingReviewSaveIntent = {
        expectedReviewRevision: conditionFixture.reviewRevision,
        title: BASE_RESULT.listing.title,
        description: BASE_RESULT.listing.description,
        condition: "good",
        specifics: sellerSpecifics("WH-1000XM4", "good"),
        // Deliberately NOT the seeded 149.99. A probe that reads the same number
        // either way cannot tell "the correction commit preserved the seller's
        // price" from "it rewrote it to the same value" (#919 review round 1).
        sellerPriceOverride: 139.49,
      };
      let overrideDuringRerun: string | null = null;
      const conditionRegenerate = vi.fn(async () => {
        await completeMockedCorrection({
          admin,
          fixture: conditionFixture,
          owner: conditionOwner,
          key: conditionKey,
          expectedReviewRevision: conditionFixture.reviewRevision,
          correctedModel: "WH-1000XM4",
          correctedCondition: "good",
        });
        overrideDuringRerun = await savedPriceOverride(
          database,
          conditionFixture.itemId,
        );
      });
      const conditionStates: string[] = [];
      const conditionReceipt = await createListingReviewSaver(
        observedDataClient(conditionData, conditionStates),
        { regenerate: conditionRegenerate },
      ).save({
        runId: conditionFixture.runId,
        idempotencyKey: conditionKey,
        intent: conditionIntent,
        userId: conditionUserId,
        bearerToken: conditionToken,
      });

      expect(conditionStates[0]).toBe("regeneration");
      expect(conditionRegenerate).toHaveBeenCalledOnce();
      expect(conditionReceipt.reviewRevision).toBe(conditionKey);
      // The correction commit itself must leave the seller's price alone: mid-rerun
      // the item still carries the SEEDED override, not the one this save stages.
      expect(overrideDuringRerun).toBe("149.99");
      expect(await correctionLedger(database, conditionUserId)).toEqual(
        unspentIncludedCorrection(1),
      );
      // …and the staged override is what the finished save leaves behind.
      expect(await reviewState(database, conditionFixture.itemId)).toEqual({
        condition: "good",
        model: "WH-1000XM4",
        price_override: "139.49",
        review_revision: conditionKey,
      });

      // The included correction is still there, so a second one also runs.
      const secondConditionKey = crypto.randomUUID();
      const secondConditionRegenerate = vi.fn(async () => {
        await completeMockedCorrection({
          admin,
          fixture: conditionFixture,
          owner: conditionOwner,
          key: secondConditionKey,
          expectedReviewRevision: conditionKey,
          expectedRunId: conditionKey,
          correctedModel: "WH-1000XM4",
          correctedCondition: "very-good",
        });
      });
      await createListingReviewSaver(conditionData, {
        regenerate: secondConditionRegenerate,
      }).save({
        runId: conditionFixture.runId,
        idempotencyKey: secondConditionKey,
        intent: {
          ...conditionIntent,
          condition: "very-good",
          expectedReviewRevision: conditionKey,
        },
        userId: conditionUserId,
        bearerToken: conditionToken,
      });
      expect(secondConditionRegenerate).toHaveBeenCalledOnce();
      expect(await correctionLedger(database, conditionUserId)).toEqual(
        unspentIncludedCorrection(2),
      );

      // The exemption is bounded. Every free rerun is a real pricing-router pass
      // and a real grounded generation against the paid provider, and skipping
      // `guided_correction_completed_at` removed the only cap those reruns used
      // to have. The third is the last free one (#919 review round 1).
      const thirdConditionKey = crypto.randomUUID();
      const thirdConditionRegenerate = vi.fn(async () => {
        await completeMockedCorrection({
          admin,
          fixture: conditionFixture,
          owner: conditionOwner,
          key: thirdConditionKey,
          expectedReviewRevision: secondConditionKey,
          expectedRunId: secondConditionKey,
          correctedModel: "WH-1000XM4",
          correctedCondition: "good",
        });
      });
      await createListingReviewSaver(conditionData, {
        regenerate: thirdConditionRegenerate,
      }).save({
        runId: conditionFixture.runId,
        idempotencyKey: thirdConditionKey,
        intent: {
          ...conditionIntent,
          condition: "good",
          expectedReviewRevision: secondConditionKey,
        },
        userId: conditionUserId,
        bearerToken: conditionToken,
      });
      expect(thirdConditionRegenerate).toHaveBeenCalledOnce();
      expect(await correctionLedger(database, conditionUserId)).toEqual(
        unspentIncludedCorrection(3),
      );

      // Past the cap the save is NOT refused — it stops being exempt and falls
      // back to the accounting it had before #919, so this one spends the
      // included correction. The counter stops moving because this rerun is no
      // longer a free one.
      const cappedConditionKey = crypto.randomUUID();
      const cappedConditionRegenerate = vi.fn(async () => {
        await completeMockedCorrection({
          admin,
          fixture: conditionFixture,
          owner: conditionOwner,
          key: cappedConditionKey,
          expectedReviewRevision: thirdConditionKey,
          expectedRunId: thirdConditionKey,
          correctedModel: "WH-1000XM4",
          correctedCondition: "very-good",
        });
      });
      await createListingReviewSaver(conditionData, {
        regenerate: cappedConditionRegenerate,
      }).save({
        runId: conditionFixture.runId,
        idempotencyKey: cappedConditionKey,
        intent: {
          ...conditionIntent,
          condition: "very-good",
          expectedReviewRevision: thirdConditionKey,
        },
        userId: conditionUserId,
        bearerToken: conditionToken,
      });
      expect(cappedConditionRegenerate).toHaveBeenCalledOnce();
      expect(await correctionLedger(database, conditionUserId)).toEqual(
        spentIncludedCorrection(3),
      );

      // …and with both the free reruns and the included correction gone, the
      // next one fails closed on the guard that was already there.
      const exhaustedConditionKey = crypto.randomUUID();
      await expect(
        createListingReviewSaver(conditionData, {
          regenerate: () =>
            completeMockedCorrection({
              admin,
              fixture: conditionFixture,
              owner: conditionOwner,
              key: exhaustedConditionKey,
              expectedReviewRevision: cappedConditionKey,
              expectedRunId: cappedConditionKey,
              correctedModel: "WH-1000XM4",
              correctedCondition: "good",
            }),
        }).save({
          runId: conditionFixture.runId,
          idempotencyKey: exhaustedConditionKey,
          intent: {
            ...conditionIntent,
            condition: "good",
            expectedReviewRevision: cappedConditionKey,
          },
          userId: conditionUserId,
          bearerToken: conditionToken,
        }),
      ).rejects.toThrow(/included guided correction is unavailable/i);
      expect(await correctionLedger(database, conditionUserId)).toEqual(
        spentIncludedCorrection(3),
      );

      // A save that also corrects identity is still an identity correction and
      // still spends the included one. This is the guard against widening the
      // exemption to "any save that touches condition".
      const identityFixture = await seedReview(
        admin,
        identityUserId,
        "condition-and-identity",
      );
      fixtures.push(identityFixture);
      const identityOwner = rlsClient(identityToken);
      const identityKey = crypto.randomUUID();
      const identityRegenerate = vi.fn(async () => {
        await completeMockedCorrection({
          admin,
          fixture: identityFixture,
          owner: identityOwner,
          key: identityKey,
          expectedReviewRevision: identityFixture.reviewRevision,
        });
      });
      await createListingReviewSaver(
        createListingReviewSaveDataClient(() => identityOwner),
        { regenerate: identityRegenerate },
      ).save({
        runId: identityFixture.runId,
        idempotencyKey: identityKey,
        intent: {
          expectedReviewRevision: identityFixture.reviewRevision,
          title: BASE_RESULT.listing.title,
          description: BASE_RESULT.listing.description,
          condition: "good",
          specifics: sellerSpecifics("WH-1000XM5", "good"),
          sellerPriceOverride: 149.99,
        },
        userId: identityUserId,
        bearerToken: identityToken,
      });
      expect(identityRegenerate).toHaveBeenCalledOnce();
      expect(await correctionLedger(database, identityUserId)).toEqual(
        spentIncludedCorrection(0),
      );

      // Spending the included correction on an identity edit cannot take the
      // seller's condition away. Condition is a different field on a different
      // decision, so it still reruns free afterwards.
      const spentConditionKey = crypto.randomUUID();
      const spentConditionRegenerate = vi.fn(async () => {
        await completeMockedCorrection({
          admin,
          fixture: identityFixture,
          owner: identityOwner,
          key: spentConditionKey,
          expectedReviewRevision: identityKey,
          expectedRunId: identityKey,
          correctedModel: "WH-1000XM5",
          correctedCondition: "very-good",
        });
      });
      const spentConditionStates: string[] = [];
      await createListingReviewSaver(
        observedDataClient(
          createListingReviewSaveDataClient(() => identityOwner),
          spentConditionStates,
        ),
        { regenerate: spentConditionRegenerate },
      ).save({
        runId: identityFixture.runId,
        idempotencyKey: spentConditionKey,
        intent: {
          expectedReviewRevision: identityKey,
          title: BASE_RESULT.listing.title,
          description: BASE_RESULT.listing.description,
          condition: "very-good",
          specifics: sellerSpecifics("WH-1000XM5", "very-good"),
          sellerPriceOverride: 149.99,
        },
        userId: identityUserId,
        bearerToken: identityToken,
      });
      expect(spentConditionStates[0]).toBe("regeneration");
      expect(spentConditionRegenerate).toHaveBeenCalledOnce();
      expect(await correctionLedger(database, identityUserId)).toEqual(
        spentIncludedCorrection(1),
      );
      expect(await reviewState(database, identityFixture.itemId)).toEqual({
        condition: "very-good",
        model: "WH-1000XM5",
        price_override: "149.99",
        review_revision: spentConditionKey,
      });

      // Free text the seller writes stays theirs and triggers nothing.
      const copyFixture = await seedReview(admin, copyUserId, "copy-only");
      fixtures.push(copyFixture);
      const copyOwner = rlsClient(copyToken);
      const copyKey = crypto.randomUUID();
      const copyStates: string[] = [];
      const copyReceipt = await createListingReviewSaver(
        observedDataClient(
          createListingReviewSaveDataClient(() => copyOwner),
          copyStates,
        ),
        {
          async regenerate() {
            throw new Error("A copy-only save must not rerun pricing.");
          },
        },
      ).save({
        runId: copyFixture.runId,
        idempotencyKey: copyKey,
        intent: {
          expectedReviewRevision: copyFixture.reviewRevision,
          title: "Seller-tightened title",
          description: "Seller-tightened description.",
          condition: "very-good",
          specifics: sellerSpecifics("WH-1000XM4", "very-good"),
          sellerPriceOverride: 159.99,
        },
        userId: copyUserId,
        bearerToken: copyToken,
      });
      expect(copyStates).toEqual(["completed"]);
      expect(copyReceipt.reviewRevision).toBe(copyKey);
      expect(await correctionLedger(database, copyUserId)).toEqual(
        unspentIncludedCorrection(0),
      );

      // Dropping the mirrored Condition specific is a SCOPE decision, not a
      // regeneration one. A caller that reaches the RPC directly can send a
      // `Condition` specific that disagrees with `p_condition` — the intent
      // schema would have rewritten it, this path has no schema — and that
      // still has to regenerate, or the incoherent value would be persisted
      // straight onto an outbound eBay path (#919 review round 1).
      const desyncFixture = await seedReview(admin, desyncUserId, "desync");
      fixtures.push(desyncFixture);
      const desyncProbe = await rlsClient(desyncToken).rpc(
        "claim_mobile_listing_review_save",
        {
          p_action: "prepare",
          p_run_id: desyncFixture.runId,
          p_idempotency_key: crypto.randomUUID(),
          p_expected_review_revision: desyncFixture.reviewRevision,
          p_title: BASE_RESULT.listing.title,
          p_description: BASE_RESULT.listing.description,
          // Unchanged. Only the mirror moves.
          p_condition: BASE_RESULT.attributes.condition,
          p_specifics: sellerSpecifics("WH-1000XM4", "poor"),
          p_price_override: 149.99,
        },
      );
      expect(desyncProbe.error).toBeNull();
      expect(desyncProbe.data).toMatchObject({ state: "regeneration" });
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
