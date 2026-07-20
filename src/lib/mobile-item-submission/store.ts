import { z } from "zod";
import {
  MobileItemSubmissionConflictError,
  MAX_MOBILE_ITEM_PHOTO_BYTES,
  mobileItemSubmissionReceiptSchema,
} from "./contract";
import type {
  MobileItemSubmissionStaging,
  StoredMobileSubmissionPhotoReceipt,
} from "./service";

type MobileItemSubmissionRpcName =
  | "find_mobile_item_submission"
  | "commit_mobile_item_submission"
  | "record_pipeline_staging_cleanup_intent"
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

const storedPhotoReceiptSchema = z
  .object({
    ordinal: z.number().int().min(0).max(3),
    storage_path: z.string().min(1).max(1_024),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byte_length: z.number().int().positive().max(MAX_MOBILE_ITEM_PHOTO_BYTES),
    media_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  })
  .strict();

const submissionRowSchema = z
  .object({
    item_id: z.string().uuid(),
    run_id: z.string().uuid(),
    queue_message_id: z.union([z.number(), z.string(), z.bigint()]),
    photo_identity_kind: z.literal("content_sha256_set_v1"),
    photo_identity_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    photo_receipts: z.array(storedPhotoReceiptSchema).min(1).max(4),
    is_replay: z.boolean(),
  })
  .strict();

function rpcData(operation: string, result: RpcResult): unknown {
  if (result.error) {
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
  });
}

export function createSupabaseMobileItemSubmissionStaging(
  client: MobileItemSubmissionRpcClient,
): MobileItemSubmissionStaging {
  return {
    async findSubmission(input) {
      const result = await client.rpc("find_mobile_item_submission", {
        p_idempotency_key: z.string().uuid().parse(input.idempotencyKey),
        p_request_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).parse(input.requestFingerprint),
        p_user_id: z.string().min(1).max(255).parse(input.userId),
      });
      const rows = z.array(submissionRowSchema).max(1).parse(
        rpcData("replay lookup", result),
      );
      return rows[0] ? receiptFromRow(rows[0]) : null;
    },

    async recordCleanupIntent(input) {
      const result = await client.rpc("record_pipeline_staging_cleanup_intent", {
        p_batch_id: z.string().uuid().parse(input.batchId),
        p_cleanup_id: z.string().uuid().parse(input.cleanupId),
        p_photo_paths: z.array(z.string().min(1).max(1_024)).min(1).max(4).parse(input.photoPaths),
        p_user_id: z.string().min(1).max(255).parse(input.userId),
      });
      return z.boolean().parse(rpcData("cleanup registration", result));
    },

    async resolveCleanupIntent(cleanupId) {
      const result = await client.rpc("resolve_pipeline_staging_cleanup_intent", {
        p_cleanup_id: z.string().uuid().parse(cleanupId),
      });
      return z.boolean().parse(rpcData("cleanup resolution", result));
    },

    async commitSubmission(input) {
      const result = await client.rpc("commit_mobile_item_submission", {
        p_batch_id: input.batchId,
        p_cleanup_id: input.cleanupId,
        p_cost_basis: input.costBasis,
        p_daily_limit: input.dailyLimit,
        p_idempotency_key: input.idempotencyKey,
        p_per_minute_limit: input.perMinuteLimit,
        p_photo_identity: input.photoIdentity,
        p_photo_receipts: toRpcPhotoReceipts(input.photoReceipts),
        p_request_fingerprint: input.requestFingerprint,
        p_user_id: input.userId,
      });
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
