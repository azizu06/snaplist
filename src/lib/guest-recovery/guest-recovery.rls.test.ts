import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import { runPipelineMaintenance } from "@/lib/pipeline-operations/maintenance";
import { createSupabasePipelineOperationsStore } from "@/lib/pipeline-operations/store";
import { createSupabaseGuestRecoveryStore } from "./recovery-store";
import {
  GuestClaimStorageError,
  claimGuestRecovery,
  type GuestClaimObject,
} from "./service";
import { createSupabaseGuestClaimStore } from "./store";
import { createSupabaseGuestClaimStorage } from "./storage";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const encryptedArtifact = {
  version: 1 as const,
  algorithm: "aes-256-gcm" as const,
  keyId: "guest-recovery-test-v1",
  keyEnvelope: Buffer.alloc(32, 1).toString("base64"),
  nonce: Buffer.alloc(12, 2).toString("base64"),
  tag: Buffer.alloc(16, 3).toString("base64"),
  ciphertext: Buffer.from("encrypted-draft-artifact").toString("base64"),
};

interface Fixture {
  guest: ClerkTestUser;
  target: ClerkTestUser;
  recoveryId: string;
  recoveryTokenHash: string;
  itemId: string;
  runId: string;
  draftId: string;
  predictionId: string;
  reservationId: string;
  guestPeriodId: string;
  targetPeriodId: string | null;
  reviewRevision: string;
  completedAt: string;
  objects: Array<Omit<GuestClaimObject, "destinationPath">>;
}

let reachable = false;
let admin: SupabaseClient;
let database: Client;
let lease: ExclusiveTestResourceLease | undefined;
const users: ClerkTestUser[] = [];
const recoveryIds: string[] = [];
const claimLeaseIds = new Set<string>();
const storagePaths = new Set<string>();

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

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function createFixture(
  label: string,
  options: {
    photoContents?: string[];
    completedAt?: string;
    targetHasIncludedPeriod?: boolean;
  } = {},
): Promise<Fixture> {
  const [guest, target] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, `guest_recovery_${label}`),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, `guest_target_${label}`),
  ]);
  users.push(guest, target);

  const recoveryId = crypto.randomUUID();
  const recoveryTokenHash = createHash("sha256")
    .update(`recovery-token-${label}-${recoveryId}`)
    .digest("hex");
  const itemId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const draftId = crypto.randomUUID();
  const predictionId = crypto.randomUUID();
  const reservationId = crypto.randomUUID();
  const guestPeriodId = crypto.randomUUID();
  const targetPeriodId = options.targetHasIncludedPeriod
    ? crypto.randomUUID()
    : null;
  const reviewRevision = crypto.randomUUID();
  const completedAt = options.completedAt ?? new Date().toISOString();
  const contents = options.photoContents ?? ["encrypted-front", "encrypted-back"];
  const objects: Array<Omit<GuestClaimObject, "destinationPath">> = contents.map((content, index) => {
    const bytes = new TextEncoder().encode(content);
    const sourcePath = `${guest.id}/guest-recovery/${itemId}/${index}.enc`;
    storagePaths.add(sourcePath);
    return {
      sourcePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    };
  });

  await database.query("begin");
  try {
    await database.query(
      `insert into public.items (
         id, user_id, photos, attributes, condition, identification,
         review_revision, review_content_revision
       ) values ($1, $2, $3, '{"brand":"RecoveryFixture"}'::jsonb,
         'good', '{"kind":"fixture"}'::jsonb, $4, $4)`,
      [itemId, guest.id, objects.map((object) => object.sourcePath), reviewRevision],
    );
    await database.query(
      `insert into public.pipeline_runs (
         id, user_id, item_id, status, stage, idempotency_key, completed_at
       ) values ($1, $2, $3, 'succeeded', 'completed', $4, $5)`,
      [runId, guest.id, itemId, `guest-recovery-${label}-${runId}`, completedAt],
    );
    await database.query(
      `insert into public.prediction_logs (
         id, user_id, item_id, run_id, extracted_attrs, price, price_range,
         confidence, tier_fired, model, listing_model, sources
       ) values ($1, $2, $3, $4, '{"brand":"RecoveryFixture"}'::jsonb,
         25, '{"low":20,"high":30}'::jsonb, 0.8, 'llm-only',
         'offline-model', 'offline-listing', '[]'::jsonb)`,
      [predictionId, guest.id, itemId, runId],
    );
    await database.query(
      `insert into public.listings (
         id, user_id, item_id, platform, title, description, copy, status,
         run_id, source_review_revision
       ) values ($1, $2, $3, 'ebay', 'Recovery fixture',
         'A coherent editable draft.', '{}'::jsonb, 'draft', $4, $5)`,
      [draftId, guest.id, itemId, runId, reviewRevision],
    );
    await database.query(
      "update public.pipeline_runs set listing_id = $1 where id = $2",
      [draftId, runId],
    );
    await database.query(
      `insert into public.ai_item_allowance_periods (
         id, user_id, source, period_key, period_start, expires_date,
         state, allowance
       ) values ($1, $2, 'included', 'included-first-run',
         '-infinity', 'infinity', 'active', 1)`,
      [guestPeriodId, guest.id],
    );
    if (targetPeriodId) {
      await database.query(
        `insert into public.ai_item_allowance_periods (
           id, user_id, source, period_key, period_start, expires_date,
           state, allowance
         ) values ($1, $2, 'included', 'included-first-run',
           '-infinity', 'infinity', 'active', 1)`,
        [targetPeriodId, target.id],
      );
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(objects.map((object) => object.sourcePath)))
      .digest("hex");
    await database.query(
      `insert into public.ai_item_credit_reservations (
         id, user_id, pipeline_run_id, item_id, allowance_period_id,
         logical_run_key, photo_set_fingerprint, state, settled_at,
         settled_review_revision, listing_id, prediction_log_id
       ) values ($1, $2, $3, $4, $5, $6, $7, 'settled', $8, $9, $10, $11)`,
      [
        reservationId,
        guest.id,
        runId,
        itemId,
        guestPeriodId,
        `guest-recovery-${label}-${runId}`,
        fingerprint,
        completedAt,
        reviewRevision,
        draftId,
        predictionId,
      ],
    );
    await database.query(
      `insert into public.notifications (
         user_id, kind, title, body, href, item_id, listing_id,
         source_pipeline_run_id
       ) values ($1, 'listing_ready', 'Draft ready', 'Review it.', $2,
         $3, $4, $5)`,
      [guest.id, `/review/${itemId}`, itemId, draftId, runId],
    );
    await database.query(
      `insert into private.pipeline_run_usage_reservations (
         run_id, user_id, daily_bucket, minute_bucket, daily_limit,
         per_minute_limit
       ) values ($1, $2, current_date, date_trunc('minute', statement_timestamp()),
         100, 100)`,
      [runId, guest.id],
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  }

  for (const [index, object] of objects.entries()) {
    const bytes = new TextEncoder().encode(contents[index]);
    const uploaded = await admin.storage.from("photos").upload(
      object.sourcePath,
      arrayBuffer(bytes),
      { contentType: "image/jpeg", upsert: false },
    );
    if (uploaded.error) throw new Error(uploaded.error.message);
  }
  recoveryIds.push(recoveryId);
  return {
    guest,
    target,
    recoveryId,
    recoveryTokenHash,
    itemId,
    runId,
    draftId,
    predictionId,
    reservationId,
    guestPeriodId,
    targetPeriodId,
    reviewRevision,
    completedAt,
    objects,
  };
}

function recoveryStore() {
  return createSupabaseGuestRecoveryStore(admin as never);
}

function claimStore() {
  const store = createSupabaseGuestClaimStore(admin as never);
  return {
    ...store,
    async beginClaim(input: Parameters<typeof store.beginClaim>[0]) {
      const outcome = await store.beginClaim(input);
      if (outcome.outcome === "copy_required") {
        claimLeaseIds.add(outcome.claimLeaseToken);
      }
      return outcome;
    },
  };
}

function claimStorage() {
  const storage = createSupabaseGuestClaimStorage(admin as never);
  return {
    async copyAndVerify(object: GuestClaimObject) {
      storagePaths.add(object.destinationPath);
      const segments = object.destinationPath.split("/");
      const leaseId = segments.at(-2);
      if (leaseId) claimLeaseIds.add(leaseId);
      return storage.copyAndVerify(object);
    },
  };
}

async function register(fixture: Fixture, shaOverride?: string) {
  return recoveryStore().register({
    recoveryId: fixture.recoveryId,
    guestUserId: fixture.guest.id,
    pipelineRunId: fixture.runId,
    recoveryTokenHash: fixture.recoveryTokenHash,
    encryptedArtifact,
    storageManifest: fixture.objects.map(({ sourcePath, sha256, byteLength }) => ({
      sourcePath,
      sha256: shaOverride ?? sha256,
      byteLength,
    })),
  });
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  lease = await acquireExclusiveTestResource(
    `local-db:guest-claim-or-expire:${SUPABASE_URL}`,
  );
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  database = new Client({ connectionString: resolveLocalTestDatabaseUrl() });
  await database.connect();
});

afterAll(async () => {
  if (!reachable) return;
  await admin.storage.from("photos").remove([...storagePaths]);
  if (recoveryIds.length > 0) {
    await database.query(
      "delete from private.pipeline_storage_cleanup_jobs where source_type = 'guest_recovery' and source_id = any($1::uuid[])",
      [recoveryIds],
    );
    await database.query(
      "delete from private.guest_draft_recoveries where id = any($1::uuid[])",
      [recoveryIds],
    );
  }
  if (claimLeaseIds.size > 0) {
    await database.query(
      "delete from private.pipeline_storage_cleanup_jobs where source_type = 'guest_claim_copy' and source_id = any($1::uuid[])",
      [[...claimLeaseIds]],
    );
  }
  await cleanupClerkTestUsers(admin, users.map((user) => user.id));
  await database.end();
  await lease?.release();
});

describe("guest recovery live DB/RLS and private Storage boundary", () => {
  it("replays one encrypted draft, atomically claims every record, and remaps the exact #168 reservation", async () => {
    if (!reachable) return;
    const fixture = await createFixture("claim", {
      targetHasIncludedPeriod: true,
    });
    const before = await database.query(
      `select id, pipeline_run_id, item_id, logical_run_key, state,
        reserved_at, settled_at, restored_at, settled_review_revision,
        listing_id, prediction_log_id, guided_correction_revision,
        guided_correction_started_at, guided_correction_completed_at
       from public.ai_item_credit_reservations where id = $1`,
      [fixture.reservationId],
    );

    const first = await register(fixture);
    const replay = await register(fixture);
    expect(first).toMatchObject({
      outcome: "recoverable",
      runId: fixture.runId,
      encryptedArtifact,
    });
    expect(replay).toEqual(first);
    if (first.outcome !== "recoverable") throw new Error("expected recovery");
    expect(
      new Date(first.expiresAt).getTime() - new Date(first.usableDraftAt).getTime(),
    ).toBe(24 * 60 * 60 * 1_000);
    expect(new Date(first.usableDraftAt).getTime()).toBe(
      new Date(fixture.completedAt).getTime(),
    );

    const outcome = await claimGuestRecovery(
      {
        handoff: {
          recoveryId: fixture.recoveryId,
          guestUserId: fixture.guest.id,
          recoveryTokenHash: fixture.recoveryTokenHash,
        },
        targetUserId: fixture.target.id,
      },
      { store: claimStore(), storage: claimStorage() },
    );
    expect(outcome).toMatchObject({ outcome: "claimed", purgeLocalRecovery: true });

    const after = await database.query(
      `select id, pipeline_run_id, item_id, logical_run_key, state,
        reserved_at, settled_at, restored_at, settled_review_revision,
        listing_id, prediction_log_id, guided_correction_revision,
        guided_correction_started_at, guided_correction_completed_at,
        user_id, allowance_period_id
       from public.ai_item_credit_reservations where id = $1`,
      [fixture.reservationId],
    );
    expect(after.rows[0]).toMatchObject({
      ...before.rows[0],
      user_id: fixture.target.id,
      allowance_period_id: fixture.targetPeriodId,
    });
    expect(
      await database.query(
        "select count(*)::integer as count from public.ai_item_credit_reservations where pipeline_run_id = $1",
        [fixture.runId],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });

    const [targetItem, guestItem] = await Promise.all([
      fixture.target.client.from("items").select("id, photos").eq("id", fixture.itemId),
      fixture.guest.client.from("items").select("id").eq("id", fixture.itemId),
    ]);
    expect(targetItem.data).toHaveLength(1);
    const claimedPhotos = targetItem.data?.[0]?.photos as string[];
    expect(claimedPhotos).toHaveLength(fixture.objects.length);
    claimedPhotos.forEach((path, index) => {
      expect(path).toMatch(new RegExp(
        `^${fixture.target.id}/guest-claims/${fixture.recoveryId}/[0-9a-f-]{36}/${index + 1}$`,
      ));
    });
    expect(guestItem.data).toEqual([]);

    for (const path of claimedPhotos) {
      const downloaded = await fixture.target.client.storage
        .from("photos")
        .download(path);
      expect(downloaded.error).toBeNull();
    }
    const attribution = await database.query(
      `select
         (select user_id from public.notifications where source_pipeline_run_id = $1) as notification_user,
         (select user_id from private.pipeline_run_usage_reservations where run_id = $1) as usage_user,
         (select count(*)::integer from public.ai_item_allowance_periods where id = $2) as guest_periods`,
      [fixture.runId, fixture.guestPeriodId],
    );
    expect(attribution.rows[0]).toEqual({
      notification_user: fixture.target.id,
      usage_user: fixture.target.id,
      guest_periods: 0,
    });

    await expect(
      claimGuestRecovery(
        {
          handoff: {
            recoveryId: fixture.recoveryId,
            guestUserId: fixture.guest.id,
            recoveryTokenHash: fixture.recoveryTokenHash,
          },
          targetUserId: fixture.target.id,
        },
        { store: claimStore(), storage: claimStorage() },
      ),
    ).resolves.toEqual(outcome);
    await expect(
      recoveryStore().recover({
        recoveryId: fixture.recoveryId,
        guestUserId: fixture.guest.id,
        recoveryTokenHash: fixture.recoveryTokenHash,
      }),
    ).resolves.toEqual(outcome);

    const otherTarget = `${fixture.target.id}_other`;
    await expect(claimStore().beginClaim({
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: otherTarget,
      guestUserId: fixture.guest.id,
      leaseSeconds: 300,
    })).rejects.toThrow(/not found/i);
    await expect(claimStore().releaseClaim({
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: otherTarget,
      claimLeaseToken: crypto.randomUUID(),
    })).rejects.toThrow(/not found/i);
    await expect(claimStore().completeClaim({
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: otherTarget,
      claimLeaseToken: crypto.randomUUID(),
      verifiedObjects: [{
        destinationPath: `${otherTarget}/guest-claims/${fixture.recoveryId}/${crypto.randomUUID()}/1`,
        sha256: "f".repeat(64),
        byteLength: 1,
      }],
    })).rejects.toThrow(/not found/i);

    const entitlement = await admin.rpc("get_verified_ai_item_entitlement", {
      p_user_id: fixture.target.id,
    });
    expect(entitlement.error).toBeNull();
    expect(entitlement.data?.[0]).toMatchObject({
      billing_source: "included",
      remaining_items: 0,
    });
  }, 20_000);

  it("claims the current guided-correction prediction/run without changing settled accounting", async () => {
    if (!reachable) return;
    const fixture = await createFixture("guided_correction");
    const correctedRunId = crypto.randomUUID();
    const correctedPredictionId = crypto.randomUUID();
    await database.query("begin");
    try {
      await database.query(
        `insert into public.prediction_logs (
           id, user_id, item_id, run_id, extracted_attrs, price, price_range,
           confidence, tier_fired, model, listing_model, sources
         ) values ($1, $2, $3, $4, '{"brand":"CorrectedFixture"}'::jsonb,
           27, '{"low":22,"high":32}'::jsonb, 0.9, 'llm-only',
           'offline-corrected-model', 'offline-corrected-listing', '[]'::jsonb)`,
        [correctedPredictionId, fixture.guest.id, fixture.itemId, correctedRunId],
      );
      await database.query(
        `update public.items
         set attributes = '{"brand":"CorrectedFixture"}'::jsonb,
             review_revision = $1,
             review_content_revision = $1
         where id = $2 and user_id = $3`,
        [correctedRunId, fixture.itemId, fixture.guest.id],
      );
      await database.query(
        `update public.listings
         set run_id = $1, source_review_revision = $1
         where id = $2 and user_id = $3`,
        [correctedRunId, fixture.draftId, fixture.guest.id],
      );
      await database.query(
        `update public.ai_item_credit_reservations
         set guided_correction_revision = $1,
             guided_correction_started_at = statement_timestamp(),
             guided_correction_completed_at = statement_timestamp(),
             updated_at = statement_timestamp()
         where id = $2`,
        [fixture.reviewRevision, fixture.reservationId],
      );
      await database.query("commit");
    } catch (error) {
      await database.query("rollback");
      throw error;
    }

    await register(fixture);
    await expect(claimGuestRecovery(
      {
        handoff: {
          recoveryId: fixture.recoveryId,
          guestUserId: fixture.guest.id,
          recoveryTokenHash: fixture.recoveryTokenHash,
        },
        targetUserId: fixture.target.id,
      },
      { store: claimStore(), storage: claimStorage() },
    )).resolves.toMatchObject({ outcome: "claimed" });

    const transferred = await database.query(
      `select
         (select user_id from public.prediction_logs where id = $1) as settled_prediction_user,
         (select user_id from public.prediction_logs where id = $2) as corrected_prediction_user,
         (select run_id from public.listings where id = $3) as draft_run_id,
         (select state from public.ai_item_credit_reservations where id = $4) as reservation_state,
         (select count(*)::integer from public.ai_item_credit_reservations where id = $4) as reservation_count`,
      [
        fixture.predictionId,
        correctedPredictionId,
        fixture.draftId,
        fixture.reservationId,
      ],
    );
    expect(transferred.rows[0]).toEqual({
      settled_prediction_user: fixture.target.id,
      corrected_prediction_user: fixture.target.id,
      draft_run_id: correctedRunId,
      reservation_state: "settled",
      reservation_count: 1,
    });
  }, 20_000);

  it("keeps guest state claimable when Storage verification fails", async () => {
    if (!reachable) return;
    const fixture = await createFixture("copy_failure", {
      photoContents: ["copy-failure-source"],
    });
    await register(fixture, "f".repeat(64));

    await expect(
      claimGuestRecovery(
        {
          handoff: {
            recoveryId: fixture.recoveryId,
            guestUserId: fixture.guest.id,
            recoveryTokenHash: fixture.recoveryTokenHash,
          },
          targetUserId: fixture.target.id,
        },
        { store: claimStore(), storage: claimStorage() },
      ),
    ).rejects.toBeInstanceOf(GuestClaimStorageError);

    const state = await database.query(
      "select state, claim_target_user_id from private.guest_draft_recoveries where id = $1",
      [fixture.recoveryId],
    );
    expect(state.rows[0]).toEqual({ state: "claimable", claim_target_user_id: null });
    expect(
      await fixture.guest.client.from("items").select("id").eq("id", fixture.itemId),
    ).toMatchObject({ data: [{ id: fixture.itemId }] });
    const cleanup = await database.query(
      `select photo_paths
       from private.pipeline_storage_cleanup_jobs
       where source_type = 'guest_claim_copy'
         and photo_paths[1] like $1`,
      [`${fixture.target.id}/guest-claims/${fixture.recoveryId}/%`],
    );
    expect(cleanup.rows).toHaveLength(1);
    expect(
      (await admin.storage.from("photos").download(cleanup.rows[0].photo_paths[0])).error,
    ).not.toBeNull();
  });

  it("serializes double claim starts and replays an interrupted post-copy claim without another credit", async () => {
    if (!reachable) return;
    const fixture = await createFixture("interrupted", {
      photoContents: ["interrupted-source"],
    });
    await register(fixture);
    const input = {
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: fixture.target.id,
      guestUserId: fixture.guest.id,
      leaseSeconds: 300,
    };
    const [left, right] = await Promise.all([
      claimStore().beginClaim(input),
      claimStore().beginClaim(input),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual([
      "copy_required",
      "in_progress",
    ]);
    const plan = [left, right].find((result) => result.outcome === "copy_required");
    if (!plan || plan.outcome !== "copy_required") throw new Error("missing plan");
    for (const object of plan.objects) await claimStorage().copyAndVerify(object);

    await database.query(
      "update private.guest_draft_recoveries set claim_lease_expires_at = statement_timestamp() - interval '1 second' where id = $1",
      [fixture.recoveryId],
    );
    const retryOutcome = await claimGuestRecovery(
      {
        handoff: {
          recoveryId: fixture.recoveryId,
          guestUserId: fixture.guest.id,
          recoveryTokenHash: fixture.recoveryTokenHash,
        },
        targetUserId: fixture.target.id,
      },
      { store: claimStore(), storage: claimStorage() },
    );
    expect(retryOutcome).toMatchObject({ outcome: "claimed" });
    await database.query(
      "delete from private.pipeline_storage_cleanup_jobs where source_type = 'guest_claim_copy' and source_id = $1",
      [plan.claimLeaseToken],
    );
    await expect(claimStore().queueCopyCleanup({
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: fixture.target.id,
      claimLeaseToken: plan.claimLeaseToken,
    })).resolves.toBe(true);
    await expect(claimStore().releaseClaim({
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: fixture.target.id,
      claimLeaseToken: plan.claimLeaseToken,
    })).resolves.toEqual(retryOutcome);
    const oldCleanup = await database.query(
      "select photo_paths from private.pipeline_storage_cleanup_jobs where source_type = 'guest_claim_copy' and source_id = $1",
      [plan.claimLeaseToken],
    );
    expect(oldCleanup.rows[0].photo_paths).toEqual(
      plan.objects.map((object) => object.destinationPath),
    );
    const claimed = await fixture.target.client
      .from("items")
      .select("photos")
      .eq("id", fixture.itemId)
      .single();
    expect(claimed.error).toBeNull();
    expect(claimed.data?.photos).not.toEqual(
      plan.objects.map((object) => object.destinationPath),
    );
    for (const path of claimed.data?.photos ?? []) {
      expect((await admin.storage.from("photos").download(path)).error).toBeNull();
    }
    expect(
      await database.query(
        "select count(*)::integer as count from public.ai_item_credit_reservations where id = $1 and state = 'settled'",
        [fixture.reservationId],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
  });

  it("expires at the exact server boundary, preserves accounting evidence, and queues cleanup idempotently", async () => {
    if (!reachable) return;
    const fixture = await createFixture("boundary", {
      completedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      photoContents: ["expired-source"],
    });
    await expect(register(fixture)).resolves.toMatchObject({
      outcome: "expired",
      purgeLocalRecovery: true,
    });

    const evidence = await database.query(
      `select
        (select cardinality(photos) from public.items where id = $1) as photo_count,
        (select count(*)::integer from public.listings where id = $2) as drafts,
        (select count(*)::integer from public.prediction_logs where id = $3) as predictions,
        (select count(*)::integer from public.ai_item_credit_reservations where id = $4 and state = 'settled') as reservations,
        (select count(*)::integer from public.pipeline_runs where id = $5 and status = 'succeeded') as runs,
        (select count(*)::integer from private.pipeline_storage_cleanup_jobs where source_type = 'guest_recovery' and source_id = $6) as cleanup_jobs`,
      [
        fixture.itemId,
        fixture.draftId,
        fixture.predictionId,
        fixture.reservationId,
        fixture.runId,
        fixture.recoveryId,
      ],
    );
    expect(evidence.rows[0]).toEqual({
      photo_count: 0,
      drafts: 0,
      predictions: 1,
      reservations: 1,
      runs: 1,
      cleanup_jobs: 1,
    });
    const repeated = await admin.rpc("expire_guest_draft_recoveries", {
      p_batch_size: 25,
    });
    expect(repeated).toMatchObject({
      error: null,
      data: { expiredCount: 0, skippedForLock: false },
    });
  });

  it("expires a four-photo copying claim into separate bounded source and destination cleanup jobs", async () => {
    if (!reachable) return;
    const fixture = await createFixture("four_photo_expiry", {
      photoContents: ["one", "two", "three", "four"],
    });
    await register(fixture);
    const plan = await claimStore().beginClaim({
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: fixture.target.id,
      guestUserId: fixture.guest.id,
      leaseSeconds: 300,
    });
    if (plan.outcome !== "copy_required") throw new Error("expected copy plan");
    await database.query(
      `update private.guest_draft_recoveries
       set usable_draft_at = statement_timestamp() - interval '24 hours',
           expires_at = statement_timestamp()
       where id = $1`,
      [fixture.recoveryId],
    );

    const expired = await admin.rpc("expire_guest_draft_recoveries", {
      p_batch_size: 25,
    });
    expect(expired.error).toBeNull();
    const cleanup = await database.query(
      `select
         (select state from private.guest_draft_recoveries where id = $1) as state,
         (select cardinality(photo_paths) from private.pipeline_storage_cleanup_jobs where source_type = 'guest_recovery' and source_id = $1) as source_count,
         (select cardinality(photo_paths) from private.pipeline_storage_cleanup_jobs where source_type = 'guest_claim_copy' and source_id = $2) as destination_count`,
      [fixture.recoveryId, plan.claimLeaseToken],
    );
    expect(cleanup.rows[0]).toEqual({
      state: "expired",
      source_count: 4,
      destination_count: 4,
    });
  });

  it("keeps the winning claim namespace alive when expiry and real maintenance run afterward", async () => {
    if (!reachable) return;
    const fixture = await createFixture("claim_wins_race", {
      photoContents: ["claim-wins-source"],
    });
    await register(fixture);
    const plan = await claimStore().beginClaim({
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: fixture.target.id,
      guestUserId: fixture.guest.id,
      leaseSeconds: 300,
    });
    if (plan.outcome !== "copy_required") throw new Error("expected plan");
    const verified = await Promise.all(
      plan.objects.map((object) => claimStorage().copyAndVerify(object)),
    );

    const [completion, expiry] = await Promise.all([
      claimStore().completeClaim({
        recoveryId: fixture.recoveryId,
        recoveryTokenHash: fixture.recoveryTokenHash,
        targetUserId: fixture.target.id,
        claimLeaseToken: plan.claimLeaseToken,
        verifiedObjects: verified,
      }),
      admin.rpc("expire_guest_draft_recoveries", { p_batch_size: 25 }),
    ]);
    expect(completion.outcome).toBe("claimed");
    expect(expiry.error).toBeNull();
    expect(
      await database.query(
        "select count(*)::integer as count from private.pipeline_storage_cleanup_jobs where source_type = 'guest_claim_copy' and source_id = $1",
        [plan.claimLeaseToken],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });

    const operations = createSupabasePipelineOperationsStore(admin as never);
    await runPipelineMaintenance({
      store: operations,
      photos: {
        async remove(paths) {
          const removed = await admin.storage.from("photos").remove(paths);
          if (removed.error) throw new Error(removed.error.message);
        },
      },
    });

    expect(
      (await admin.storage.from("photos").download(fixture.objects[0].sourcePath)).error,
    ).not.toBeNull();
    for (const object of plan.objects) {
      expect(
        (await admin.storage.from("photos").download(object.destinationPath)).error,
      ).toBeNull();
    }
  }, 30_000);

  it("lets exactly one terminal predicate win when claim completion races expiry cleanup", async () => {
    if (!reachable) return;
    const fixture = await createFixture("race", {
      photoContents: ["race-source"],
    });
    await register(fixture);
    const plan = await claimStore().beginClaim({
      recoveryId: fixture.recoveryId,
      recoveryTokenHash: fixture.recoveryTokenHash,
      targetUserId: fixture.target.id,
      guestUserId: fixture.guest.id,
      leaseSeconds: 300,
    });
    if (plan.outcome !== "copy_required") throw new Error("expected plan");
    const verified = await Promise.all(
      plan.objects.map((object) => claimStorage().copyAndVerify(object)),
    );
    await database.query(
      `update private.guest_draft_recoveries
       set usable_draft_at = statement_timestamp() - interval '24 hours',
           expires_at = statement_timestamp()
       where id = $1`,
      [fixture.recoveryId],
    );

    const [completion, cleanup] = await Promise.all([
      claimStore().completeClaim({
        recoveryId: fixture.recoveryId,
        recoveryTokenHash: fixture.recoveryTokenHash,
        targetUserId: fixture.target.id,
        claimLeaseToken: plan.claimLeaseToken,
        verifiedObjects: verified,
      }),
      admin.rpc("expire_guest_draft_recoveries", { p_batch_size: 25 }),
    ]);
    expect(completion.outcome).toBe("expired");
    expect(cleanup.error).toBeNull();
    const terminal = await database.query(
      "select state, claimed_at, expired_at from private.guest_draft_recoveries where id = $1",
      [fixture.recoveryId],
    );
    expect(terminal.rows[0]).toMatchObject({ state: "expired", claimed_at: null });
    expect(terminal.rows[0].expired_at).not.toBeNull();
    const sourceCleanupPaths = await database.query(
      "select photo_paths from private.pipeline_storage_cleanup_jobs where source_type = 'guest_recovery' and source_id = $1",
      [fixture.recoveryId],
    );
    expect(sourceCleanupPaths.rows[0].photo_paths).toEqual([
      fixture.objects[0].sourcePath,
    ]);
    const copyCleanupPaths = await database.query(
      "select photo_paths from private.pipeline_storage_cleanup_jobs where source_type = 'guest_claim_copy' and source_id = $1",
      [plan.claimLeaseToken],
    );
    expect(copyCleanupPaths.rows[0].photo_paths).toEqual([
      plan.objects[0].destinationPath,
    ]);
    expect(
      await database.query(
        "select count(*)::integer as count from public.items where id = $1 and user_id = $2",
        [fixture.itemId, fixture.target.id],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });
  });
});
