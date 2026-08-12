import { createHash } from "node:crypto";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineResult } from "@/lib/pipeline";
import type { PipelineWorkerContext } from "./worker-store";
import { stackReachable } from "@/test/supabase-stack";

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { createInternalPipelineWorkerCapabilities } from "./internal";

const RUN_ID = "63870000-0000-4000-8000-000000000001";
const ITEM_ID = "63870000-0000-4000-8000-000000000002";
const RECOVERY_ID = "63870000-0000-4000-8000-000000000003";
const LEASE_TOKEN = "63870000-0000-4000-8000-000000000004";
const LISTING_ID = "63870000-0000-4000-8000-000000000005";
const ORIGINAL_PATH = "guest/raw/front.jpg";
const GUEST_USER_ID = "guest_0123456789abcdef0123456789abcdef0123456789abcdef";
const MASTER_KEY = new Uint8Array(32).fill(7);
const LOCAL_DATABASE_URL =
  process.env.SNAPLIST_GUEST_RECOVERY_TEST_DATABASE_URL
  ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stackIsReachable = await stackReachable();

const result = {
  attributes: { brand: "Sony", condition: "good", model: "WH-1000XM5" },
  price: {
    suggested: 180,
    range: { min: 160, max: 205 },
    confidence: 0.7,
    sources: [],
    tier: "llm-only",
    evidence: [],
  },
  confidence: { score: 0.7, band: "high", autopilotEligible: false },
  listing: {
    platform: "ebay",
    title: "Sony WH-1000XM5 Headphones",
    description: "Seller-owned draft.",
    fields: {},
  },
  identification: {
    label: "Sony WH-1000XM5 Headphones",
    confident: true,
    evidence: 1,
  },
  model: "vision-model",
  listingModel: "listing-model",
} satisfies PipelineResult;

function guestContext(
  overrides: { photos?: string[]; recoveryId?: string } = {},
): PipelineWorkerContext {
  return {
    run: {
      id: RUN_ID,
      user_id: GUEST_USER_ID,
      item_id: ITEM_ID,
      listing_id: null,
      status: "running",
      stage: "generating",
      schema_version: 1,
      attempt_count: 1,
      max_attempts: 3,
      autopilot_enabled: false,
      checkpoint: {},
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-04T12:00:00.000Z",
      next_attempt_at: null,
      recovery_id: overrides.recoveryId ?? RECOVERY_ID,
      recovery_token_hash: "a".repeat(64),
    },
    item: {
      id: ITEM_ID,
      user_id: GUEST_USER_ID,
      photos: overrides.photos ?? [ORIGINAL_PATH],
      photo_identity_kind: "content_sha256_set_v1",
      photo_identity_fingerprint: "b".repeat(64),
      attributes: {},
      condition: null,
      cost_basis: null,
      review_revision: "63870000-0000-4000-8000-000000000006",
      review_content_revision: "63870000-0000-4000-8000-000000000007",
    },
  };
}

afterEach(() => {
  delete process.env.GUEST_RECOVERY_ENCRYPTION_KEY;
  delete process.env.GUEST_RECOVERY_ENCRYPTION_KEY_ID;
  vi.clearAllMocks();
});

describe("production guest recovery worker composition", () => {
  it("uses the private photos bucket and carries the produced registration through completion", async () => {
    process.env.GUEST_RECOVERY_ENCRYPTION_KEY = Buffer.from(MASTER_KEY).toString("base64");
    process.env.GUEST_RECOVERY_ENCRYPTION_KEY_ID = "guest-recovery-key-v1";
    const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>([
      [ORIGINAL_PATH, {
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        mediaType: "image/jpeg",
      }],
    ]);
    const download = vi.fn(async (path: string) => {
      const object = objects.get(path);
      return object
        ? {
            data: new Blob([Buffer.from(object.bytes)], { type: object.mediaType }),
            error: null,
          }
        : { data: null, error: { message: "missing object" } };
    });
    const upload = vi.fn(async (path: string, bytes: Uint8Array) => {
      if (objects.has(path)) return { error: { message: "already exists" } };
      objects.set(path, {
        bytes: Uint8Array.from(bytes),
        mediaType: "application/octet-stream",
      });
      return { error: null };
    });
    const from = vi.fn(() => ({ download, upload }));
    const rpc = vi.fn(async (functionName: string) => ({
      data: functionName === "complete_pipeline_run_with_guest_recovery"
        ? { listingId: LISTING_ID }
        : true,
      error: null,
    }));
    createAdminClient.mockReturnValue({ rpc, storage: { from } });

    const capabilities = createInternalPipelineWorkerCapabilities();
    const stageGuestRecoveryUploadCleanup = vi.fn(async (paths: string[]) => {
      await capabilities.runs.stageGuestRecoveryUploadCleanup({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        paths,
      });
    });
    const registration = await capabilities.guestRecovery.prepare({
      context: guestContext(),
      result,
      stageUploadCleanup: stageGuestRecoveryUploadCleanup,
    });
    const completion = await capabilities.runs.complete({
      runId: RUN_ID,
      leaseToken: LEASE_TOKEN,
      result,
      autopilotEnabled: false,
      guestRecoveryRegistration: registration,
    });

    expect(completion).toEqual({ listingId: LISTING_ID });
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("photos");
    expect(stageGuestRecoveryUploadCleanup).toHaveBeenCalledOnce();
    const recoveryPath = registration!.storageManifest[0]!.sourcePath;
    const stored = objects.get(recoveryPath)!;
    expect(stored.mediaType).toBe("application/octet-stream");
    expect(createHash("sha256").update(stored.bytes).digest("hex")).toBe(
      registration!.storageManifest[0]!.sha256,
    );
    expect(stored.bytes.byteLength).toBe(objects.get(ORIGINAL_PATH)!.bytes.byteLength + 37);
    expect(Buffer.from(stored.bytes.subarray(0, 8)).toString("ascii"))
      .toBe("SGLRPHO1");
    expect(rpc).toHaveBeenCalledWith(
      "complete_pipeline_run_with_guest_recovery",
      expect.objectContaining({ p_guest_recovery_registration: registration }),
    );
  });

  // Every other test on this path stubs `storage`, so the mime type the
  // producer declares is only ever checked against the stub that recorded it.
  // The `photos` bucket allowlist lives in SQL and rejected the real write with
  // a 415 in production. This test is the join: the real bucket policy decides.
  it.skipIf(!stackIsReachable)(
    "writes the guest recovery envelope into the real photos bucket",
    async () => {
      process.env.GUEST_RECOVERY_ENCRYPTION_KEY = Buffer.from(MASTER_KEY)
        .toString("base64");
      process.env.GUEST_RECOVERY_ENCRYPTION_KEY_ID = "guest-recovery-key-v1";
      const storage = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!).storage;
      const bucket = storage.from("photos");
      const recoveryId = crypto.randomUUID();
      const originalPath =
        `${GUEST_USER_ID}/pipeline-staging/${recoveryId}/0/front.jpg`;
      const uploaded = [originalPath];
      try {
        const seeded = await bucket.upload(
          originalPath,
          new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          { contentType: "image/jpeg", upsert: true },
        );
        expect(seeded.error).toBeNull();
        createAdminClient.mockReturnValue({
          rpc: async () => {
            throw new Error("Unexpected RPC during envelope production");
          },
          storage,
        });

        const registration = await createInternalPipelineWorkerCapabilities()
          .guestRecovery.prepare({
            context: guestContext({ photos: [originalPath], recoveryId }),
            result,
            stageUploadCleanup: async () => {},
          });

        const envelope = registration!.storageManifest[0]!;
        uploaded.push(envelope.sourcePath);
        const stored = await bucket.download(envelope.sourcePath);
        expect(stored.error).toBeNull();
        expect(stored.data!.type).toBe("application/octet-stream");
        const bytes = new Uint8Array(await stored.data!.arrayBuffer());
        expect(createHash("sha256").update(bytes).digest("hex"))
          .toBe(envelope.sha256);
      } finally {
        await bucket.remove(uploaded);
      }
    },
    30_000,
  );

  // The envelope type has to be *appended*. Asserted through real uploads
  // rather than by reading `storage.buckets.allowed_mime_types`, so a migration
  // that rewrote the array wholesale fails here on the type it dropped.
  it.skipIf(!stackIsReachable)(
    "keeps accepting every content type the photos bucket accepted before",
    async () => {
      const bucket = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!)
        .storage.from("photos");
      const prefix = `${GUEST_USER_ID}/mime-allowlist/${crypto.randomUUID()}`;
      const uploaded: string[] = [];
      try {
        for (const contentType of [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/heic",
          "image/heif",
          "audio/wav",
        ]) {
          const path = `${prefix}/${contentType.replace("/", "-")}`;
          const { error } = await bucket.upload(
            path,
            new Uint8Array([0x00, 0x01, 0x02, 0x03]),
            { contentType, upsert: true },
          );
          uploaded.push(path);
          expect(error?.message ?? null, contentType).toBeNull();
        }
      } finally {
        await bucket.remove(uploaded);
      }
    },
    30_000,
  );

  it.skipIf(!stackIsReachable)(
    "carries a committed local-stack guest run through production composition to recovery and handoff",
    async () => {
      process.env.GUEST_RECOVERY_ENCRYPTION_KEY = Buffer.from(MASTER_KEY)
        .toString("base64");
      process.env.GUEST_RECOVERY_ENCRYPTION_KEY_ID = "guest-recovery-key-v1";
      const database = new Client({ connectionString: LOCAL_DATABASE_URL });
      await database.connect();
      await database.query("begin");
      try {
        const appAttestKeyId = Buffer.alloc(32, 1).toString("base64");
        const appId = "TEAMID1234.dev.snaplist.ios";
        const guestUserId = `guest_${createHash("sha256")
          .update(appId)
          .update(Buffer.from([0]))
          .update(appAttestKeyId)
          .digest("hex")
          .slice(0, 48)}`;
        const capabilityId = "63880000-0000-4000-8000-000000000001";
        const idempotencyKey = "63880000-0000-4000-8000-000000000002";
        const cleanupId = "63880000-0000-4000-8000-000000000003";
        const recoveryId = "63880000-0000-4000-8000-000000000004";
        const handoffId = "63880000-0000-4000-8000-000000000005";
        const originalPath = `${guestUserId}/pipeline-staging/${idempotencyKey}/0/front.jpg`;
        const rawRecoveryToken = "native-only-e2e-recovery-token";
        const recoveryTokenHash = createHash("sha256")
          .update(rawRecoveryToken)
          .digest("hex");
        const contentHash = "b".repeat(64);
        const photoFingerprint = createHash("sha256")
          .update(contentHash)
          .digest("hex");
        const requestFingerprint = "a".repeat(64);
        const photoReceipts = [{
          ordinal: 0,
          storage_path: originalPath,
          content_sha256: contentHash,
          byte_length: 4,
          media_type: "image/jpeg",
        }];

        await database.query(
          "select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify({ role: "service_role", sub: "guest-recovery-e2e" })],
        );
        await database.query(
          `select public.issue_verified_guest_capability(
             $1::uuid, $2, decode(repeat('63', 32), 'hex'),
             statement_timestamp(), statement_timestamp() + interval '15 minutes'
           )`,
          [capabilityId, guestUserId],
        );
        await database.query("set local role authenticated");
        await database.query(
          "select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify({
            role: "authenticated",
            actor: "verified_guest",
            sub: guestUserId,
            cap_id: capabilityId,
            snaplist_operation_channel: "verified_guest_publishable",
          })],
        );
        await database.query(
          `select public.begin_mobile_item_submission_v3(
             $1::uuid, $2::text, null::text, $3::uuid, $4::uuid, 0::numeric,
             $5::jsonb, null::jsonb, $6::uuid, $7::text
           )`,
          [
            idempotencyKey,
            requestFingerprint,
            idempotencyKey,
            cleanupId,
            JSON.stringify(photoReceipts),
            recoveryId,
            recoveryTokenHash,
          ],
        );
        const committed = await database.query<{
          denial_reason: string | null;
          item_id: string;
          queue_message_id: string;
          run_id: string;
        }>(
          `select * from public.commit_mobile_item_submission_v3(
             $1::uuid, $2::text, null::text, $3::uuid, $4::uuid,
             0::numeric, 100, 100,
             jsonb_build_object(
               'kind', 'content_sha256_set_v1', 'fingerprint', $5::text
             ),
             $6::jsonb, null::jsonb, $7::uuid, $8::text
           )`,
          [
            idempotencyKey,
            requestFingerprint,
            idempotencyKey,
            cleanupId,
            photoFingerprint,
            JSON.stringify(photoReceipts),
            recoveryId,
            recoveryTokenHash,
          ],
        );
        expect(committed.rows).toHaveLength(1);
        const receipt = committed.rows[0]!;
        expect(receipt.denial_reason).toBeNull();

        await database.query("reset role");
        await database.query(
          "select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify({ role: "service_role", sub: "guest-recovery-e2e" })],
        );
        const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>([
          [originalPath, {
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            mediaType: "image/jpeg",
          }],
        ]);
        const download = vi.fn(async (path: string) => {
          const object = objects.get(path);
          return object
            ? {
                data: new Blob([Buffer.from(object.bytes)], {
                  type: object.mediaType,
                }),
                error: null,
              }
            : { data: null, error: { message: "missing object" } };
        });
        const upload = vi.fn(async (path: string, bytes: Uint8Array) => {
          if (objects.has(path)) return { error: { message: "already exists" } };
          objects.set(path, {
            bytes: Uint8Array.from(bytes),
            mediaType: "application/octet-stream",
          });
          return { error: null };
        });
        const from = vi.fn(() => ({ download, upload }));
        createAdminClient.mockReturnValue({
          rpc: async (functionName: string, args: Record<string, unknown>) => {
            try {
              const data = await invokeWorkerRpc(database, functionName, args);
              return { data, error: null };
            } catch (error) {
              return {
                data: null,
                error: { message: error instanceof Error ? error.message : "rpc failed" },
              };
            }
          },
          storage: { from },
        });
        const capabilities = createInternalPipelineWorkerCapabilities();
        const acquisition = await capabilities.runs.acquire({
          runId: receipt.run_id,
          messageId: receipt.queue_message_id,
          leaseSeconds: 300,
        });
        expect(acquisition.kind).toBe("acquired");
        if (acquisition.kind !== "acquired") throw new Error("run not acquired");
        await capabilities.runs.checkpoint({
          runId: receipt.run_id,
          leaseToken: acquisition.context.run.lease_token,
          stage: "generating",
          checkpoint: {
            identified: {
              attributes: result.attributes,
              model: result.model,
            },
            priced: {
              result: result.price,
              evidenceAsOf: "2026-08-04T12:00:00.000Z",
            },
            generated: {
              copy: result.listing,
              model: result.listingModel,
            },
          },
          leaseSeconds: 300,
        });
        const registration = await capabilities.guestRecovery.prepare({
          context: acquisition.context,
          result,
          stageUploadCleanup: (paths) =>
            capabilities.runs.stageGuestRecoveryUploadCleanup({
              runId: receipt.run_id,
              leaseToken: acquisition.context.run.lease_token,
              paths,
            }),
        });
        const completion = await capabilities.runs.complete({
          runId: receipt.run_id,
          leaseToken: acquisition.context.run.lease_token,
          result,
          autopilotEnabled: false,
          guestRecoveryRegistration: registration,
        });

        expect(completion.listingId).toMatch(/^[0-9a-f-]{36}$/);
        expect(from).toHaveBeenCalledOnce();
        expect(from).toHaveBeenCalledWith("photos");
        const durable = await database.query<{
          fingerprint: string;
          photos: string[];
          recovery_count: number;
          recovery_json: string;
          status: string;
        }>(
          `select run.status,
                  item.photos,
                  item.photo_identity_fingerprint as fingerprint,
                  (select count(*)::integer
                   from private.guest_draft_recoveries recovery
                   where recovery.pipeline_run_id = run.id) as recovery_count,
                  (select to_jsonb(recovery)::text
                   from private.guest_draft_recoveries recovery
                   where recovery.pipeline_run_id = run.id) as recovery_json
             from public.pipeline_runs run
             join public.items item
               on item.id = run.item_id and item.user_id = run.user_id
            where run.id = $1::uuid`,
          [receipt.run_id],
        );
        expect(durable.rows[0]).toMatchObject({
          fingerprint: photoFingerprint,
          recovery_count: 1,
          status: "succeeded",
        });
        expect(durable.rows[0]!.photos).toEqual(
          registration!.storageManifest.map(({ sourcePath }) => sourcePath),
        );
        expect(durable.rows[0]!.recovery_json).not.toContain(rawRecoveryToken);

        await database.query(
          `insert into private.app_attest_keys (
             key_id, app_id, environment, public_key_pem, receipt,
             assertion_counter, bundle_version, validation_category
           ) values ($1, $2, 'production',
             '-----BEGIN PUBLIC KEY-----fixed', decode('01', 'hex'), 1, '1', 1)`,
          [appAttestKeyId, appId],
        );
        const issued = await database.query<{ issued: boolean }>(
          `select public.issue_guest_claim_handoff(
             $1::uuid, decode(repeat('ab', 32), 'hex'), $2, $3,
             'production', $4, $5::uuid, $6, $7,
             statement_timestamp(), statement_timestamp() + interval '5 minutes'
           ) as issued`,
          [
            handoffId,
            appAttestKeyId,
            appId,
            guestUserId,
            recoveryId,
            recoveryTokenHash,
            photoFingerprint,
          ],
        );
        expect(issued.rows[0]?.issued).toBe(true);
        const handoff = await database.query<{ fingerprint: string }>(
          `select photo_set_fingerprint as fingerprint
             from private.guest_claim_handoffs
            where handoff_id = $1::uuid`,
          [handoffId],
        );
        expect(handoff.rows[0]?.fingerprint).toBe(photoFingerprint);
      } finally {
        await database.query("rollback");
        await database.end();
      }
    },
    30_000,
  );
});

async function invokeWorkerRpc(
  database: Client,
  functionName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (functionName) {
    case "claim_pipeline_run_attempt":
      return (await database.query<{ data: unknown }>(
        `select public.claim_pipeline_run_attempt(
           $1::uuid, $2::bigint, $3::integer
         ) as data`,
        [args.p_run_id, args.p_message_id, args.p_lease_seconds],
      )).rows[0]?.data;
    case "checkpoint_pipeline_run":
      return (await database.query<{ data: unknown }>(
        `select public.checkpoint_pipeline_run(
           $1::uuid, $2::uuid, $3, $4::jsonb, $5::integer
         ) as data`,
        [
          args.p_run_id,
          args.p_lease_token,
          args.p_stage,
          JSON.stringify(args.p_checkpoint),
          args.p_lease_seconds,
        ],
      )).rows[0]?.data;
    case "stage_guest_recovery_upload_cleanup":
      return (await database.query<{ data: unknown }>(
        `select public.stage_guest_recovery_upload_cleanup(
           $1::uuid, $2::uuid, $3::text[]
         ) as data`,
        [args.p_run_id, args.p_lease_token, args.p_photo_paths],
      )).rows[0]?.data;
    case "complete_pipeline_run_with_guest_recovery":
      return (await database.query<{ data: unknown }>(
        `select public.complete_pipeline_run_with_guest_recovery(
           $1::uuid, $2::uuid, $3::jsonb, $4::jsonb
         ) as data`,
        [
          args.p_run_id,
          args.p_lease_token,
          JSON.stringify(args.p_persistence),
          JSON.stringify(args.p_guest_recovery_registration),
        ],
      )).rows[0]?.data;
    default:
      throw new Error(`Unexpected worker RPC: ${functionName}`);
  }
}
