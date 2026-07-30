import { z } from "zod";
import {
  MobileItemSubmissionConflictError,
  MobileItemSubmissionDeniedError,
  MAX_MOBILE_ITEM_PHOTO_BYTES,
  MAX_MOBILE_ITEM_PHOTOS,
  mobileItemSubmissionReceiptSchema,
} from "./contract";
import type {
  MobileItemSubmissionStaging,
  StoredMobileSubmissionPhotoReceipt,
  StoredMobileSubmissionVoiceReceipt,
} from "./service";
import { MAX_MOBILE_ITEM_VOICE_BYTES } from "./voice";

type MobileItemSubmissionRpcName =
  | "find_mobile_item_submission_v2"
  | "begin_mobile_item_submission_v2"
  | "commit_mobile_item_submission_v2"
  | "resolve_pipeline_staging_cleanup_intent";

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** Fixed producer capability: it deliberately exposes no generic table API. */
export interface MobileItemSubmissionRpcClient {
  rpc(
    functionName: MobileItemSubmissionRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<RpcResult>;
}

export interface MobileItemSubmissionStagingOptions {
  authority?: "service-role" | "authenticated-self";
}

const storedPhotoReceiptSchema = z
  .object({
    ordinal: z.number().int().min(0).max(MAX_MOBILE_ITEM_PHOTOS - 1),
    storage_path: z.string().min(1).max(1_024),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byte_length: z.number().int().positive().max(MAX_MOBILE_ITEM_PHOTO_BYTES),
    media_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  })
  .strict();

const storedVoiceReceiptSchema = z
  .object({
    version: z.literal(1),
    storage_path: z.string().min(1).max(1_024),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byte_length: z.number().int().positive().max(MAX_MOBILE_ITEM_VOICE_BYTES),
    duration_ms: z.number().int().positive().max(15_000),
    locale: z.string().min(1).max(255).nullable(),
    media_type: z.literal("audio/wav"),
  })
  .strict();

const submissionRowSchema = z
  .object({
    item_id: z.string().uuid(),
    run_id: z.string().uuid(),
    queue_message_id: z.union([z.number(), z.string(), z.bigint()]),
    photo_identity_kind: z.literal("content_sha256_set_v1"),
    photo_identity_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    photo_receipts: z.array(storedPhotoReceiptSchema).min(1).max(MAX_MOBILE_ITEM_PHOTOS),
    voice_receipt: storedVoiceReceiptSchema.nullable().default(null),
    is_replay: z.boolean(),
  })
  .strict();

const commitDenialReasonSchema = z.enum([
  "snaplist-pro-required",
  "storekit-entitlement-unavailable",
  "monthly-allowance-reached",
  "daily-capacity-reached",
  "per-minute-capacity-reached",
]);

const authenticatedCommitRowSchema = z.union([
  submissionRowSchema.extend({
    denial_reason: z.null().optional(),
  }),
  z
    .object({
      item_id: z.null(),
      run_id: z.null(),
      queue_message_id: z.null(),
      photo_identity_kind: z.null(),
      photo_identity_fingerprint: z.null(),
      photo_receipts: z.null(),
      voice_receipt: z.null().optional(),
      is_replay: z.literal(false),
      denial_reason: commitDenialReasonSchema,
    })
    .strict(),
]);

function deniedError(reason: z.infer<typeof commitDenialReasonSchema>) {
  return new MobileItemSubmissionDeniedError(
    reason === "daily-capacity-reached" ||
      reason === "per-minute-capacity-reached"
      ? "rate_limited"
      : "allowance_denied",
    reason,
  );
}

function rpcData(operation: string, result: RpcResult): unknown {
  if (result.error) {
    const allowanceReason = result.error.message.match(
      /AI item credit unavailable: (snaplist-pro-required|storekit-entitlement-unavailable|monthly-allowance-reached)/i,
    )?.[1]?.toLowerCase();
    if (allowanceReason) {
      throw new MobileItemSubmissionDeniedError(
        "allowance_denied",
        z.enum([
          "snaplist-pro-required",
          "storekit-entitlement-unavailable",
          "monthly-allowance-reached",
        ]).parse(allowanceReason),
      );
    }
    if (/Pipeline daily capacity reached/i.test(result.error.message)) {
      throw new MobileItemSubmissionDeniedError(
        "rate_limited",
        "daily-capacity-reached",
      );
    }
    if (/Pipeline per-minute capacity reached/i.test(result.error.message)) {
      throw new MobileItemSubmissionDeniedError(
        "rate_limited",
        "per-minute-capacity-reached",
      );
    }
    if (
      /mobile item submission idempotency conflict|pipeline cleanup intent conflicts/i.test(
        result.error.message,
      )
    ) {
      throw new MobileItemSubmissionConflictError();
    }
    throw new Error(`Mobile item submission ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

function toRpcPhotoReceipts(receipts: StoredMobileSubmissionPhotoReceipt[]) {
  return receipts.map((receipt) => ({
    ordinal: receipt.ordinal,
    storage_path: receipt.storagePath,
    content_sha256: receipt.contentSha256,
    byte_length: receipt.byteLength,
    media_type: receipt.mediaType,
  }));
}

function toRpcVoiceReceipt(receipt: StoredMobileSubmissionVoiceReceipt | null) {
  if (receipt == null) return null;
  return {
    version: receipt.version,
    storage_path: receipt.storagePath,
    content_sha256: receipt.contentSha256,
    byte_length: z
      .number()
      .int()
      .positive()
      .max(MAX_MOBILE_ITEM_VOICE_BYTES)
      .parse(receipt.byteLength),
    duration_ms: receipt.durationMs,
    locale: receipt.locale,
    media_type: receipt.mediaType,
  };
}

function legacyRequestFingerprint(value: string | null): string | null {
  return z.string().regex(/^[0-9a-f]{64}$/).nullable().parse(value);
}

function receiptFromRow(raw: unknown) {
  const row = submissionRowSchema.parse(raw);
  return mobileItemSubmissionReceiptSchema.parse({
    itemId: row.item_id,
    runId: row.run_id,
    status: "queued",
    stage: "queued",
    photoIdentity: {
      kind: row.photo_identity_kind,
      fingerprint: row.photo_identity_fingerprint,
    },
    photos: row.photo_receipts.map((photo) => ({
      ordinal: photo.ordinal,
      contentSha256: photo.content_sha256,
      byteLength: photo.byte_length,
      mediaType: photo.media_type,
    })),
    voiceContext:
      row.voice_receipt === null
        ? null
        : {
            version: row.voice_receipt.version,
            contentSha256: row.voice_receipt.content_sha256,
            byteLength: row.voice_receipt.byte_length,
            durationMs: row.voice_receipt.duration_ms,
            mediaType: row.voice_receipt.media_type,
          },
  });
}

export function createSupabaseMobileItemSubmissionStaging(
  client: MobileItemSubmissionRpcClient,
  options: MobileItemSubmissionStagingOptions = {},
): MobileItemSubmissionStaging {
  const authority = options.authority ?? "service-role";
  return {
    async findSubmission(input) {
      const result = await client.rpc("find_mobile_item_submission_v2", {
        p_idempotency_key: z.string().uuid().parse(input.idempotencyKey),
        p_legacy_request_fingerprint: legacyRequestFingerprint(
          input.legacyRequestFingerprint,
        ),
        p_request_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).parse(input.requestFingerprint),
        ...(authority === "service-role"
          ? { p_user_id: z.string().min(1).max(255).parse(input.userId) }
          : {}),
      });
      const rows = z.array(submissionRowSchema).max(1).parse(
        rpcData("replay lookup", result),
      );
      return rows[0] ? receiptFromRow(rows[0]) : null;
    },

    async beginSubmission(input) {
      const result = await client.rpc("begin_mobile_item_submission_v2", {
        p_batch_id: z.string().uuid().parse(input.batchId),
        p_cleanup_id: z.string().uuid().parse(input.cleanupId),
        p_cost_basis: input.costBasis,
        p_idempotency_key: z.string().uuid().parse(input.idempotencyKey),
        p_legacy_request_fingerprint: legacyRequestFingerprint(
          input.legacyRequestFingerprint,
        ),
        p_photo_receipts: toRpcPhotoReceipts(input.photoReceipts),
        p_request_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).parse(input.requestFingerprint),
        p_voice_receipt: toRpcVoiceReceipt(input.voiceReceipt),
        ...(authority === "service-role"
          ? { p_user_id: z.string().min(1).max(255).parse(input.userId) }
          : {}),
      });
      return z.boolean().parse(rpcData("uploading submission binding", result));
    },

    async resolveCleanupIntent(cleanupId) {
      const result = await client.rpc("resolve_pipeline_staging_cleanup_intent", {
        p_cleanup_id: z.string().uuid().parse(cleanupId),
      });
      return z.boolean().parse(rpcData("cleanup resolution", result));
    },

    async commitSubmission(input) {
      const result = await client.rpc("commit_mobile_item_submission_v2", {
        p_batch_id: input.batchId,
        p_cleanup_id: input.cleanupId,
        p_cost_basis: input.costBasis,
        p_daily_limit: input.dailyLimit,
        p_idempotency_key: input.idempotencyKey,
        p_legacy_request_fingerprint: legacyRequestFingerprint(
          input.legacyRequestFingerprint,
        ),
        p_per_minute_limit: input.perMinuteLimit,
        p_photo_identity: input.photoIdentity,
        p_photo_receipts: toRpcPhotoReceipts(input.photoReceipts),
        p_request_fingerprint: input.requestFingerprint,
        p_voice_receipt: toRpcVoiceReceipt(input.voiceReceipt),
        ...(authority === "service-role" ? { p_user_id: input.userId } : {}),
      });
      if (authority === "authenticated-self") {
        const rows = z.array(authenticatedCommitRowSchema).length(1).parse(
          rpcData("atomic commit", result),
        );
        if (rows[0].denial_reason) {
          throw deniedError(rows[0].denial_reason);
        }
        const committed = { ...rows[0] };
        delete committed.denial_reason;
        return {
          outcome: committed.is_replay ? "replayed" : "created",
          receipt: receiptFromRow(committed),
        };
      }
      const rows = z.array(submissionRowSchema).length(1).parse(
        rpcData("atomic commit", result),
      );
      return {
        outcome: rows[0].is_replay ? "replayed" : "created",
        receipt: receiptFromRow(rows[0]),
      };
    },
  };
}
