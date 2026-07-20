import { describe, expect, it, vi } from "vitest";
import { createSupabaseMobileItemSubmissionStaging } from "./store";

const photoReceipts = [
  {
    ordinal: 0,
    storagePath:
      "user_334/pipeline-staging/33420000-0000-4000-8000-000000000001/0/0-photo.jpg",
    contentSha256: "a".repeat(64),
    byteLength: 6,
    mediaType: "image/jpeg" as const,
  },
];

describe("fixed mobile item submission RPC capability", () => {
  it("maps one verified submission into the atomic commit RPC and safe receipt", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          item_id: "33420000-0000-4000-8000-000000000002",
          run_id: "33420000-0000-4000-8000-000000000003",
          queue_message_id: 42,
          photo_identity_kind: "content_sha256_set_v1",
          photo_identity_fingerprint: "b".repeat(64),
          photo_receipts: photoReceipts.map((receipt) => ({
            ordinal: receipt.ordinal,
            storage_path: receipt.storagePath,
            content_sha256: receipt.contentSha256,
            byte_length: receipt.byteLength,
            media_type: receipt.mediaType,
          })),
          is_replay: false,
        },
      ],
      error: null,
    }));
    const staging = createSupabaseMobileItemSubmissionStaging({ rpc });

    const result = await staging.commitSubmission({
      userId: "user_334",
      idempotencyKey: "33420000-0000-4000-8000-000000000001",
      requestFingerprint: "c".repeat(64),
      batchId: "33420000-0000-4000-8000-000000000001",
      cleanupId: "33420000-0000-4000-8000-000000000004",
      costBasis: 12.34,
      dailyLimit: 15,
      perMinuteLimit: 20,
      photoIdentity: {
        kind: "content_sha256_set_v1",
        fingerprint: "b".repeat(64),
      },
      photoReceipts,
    });

    expect(result).toMatchObject({
      outcome: "created",
      receipt: {
        itemId: "33420000-0000-4000-8000-000000000002",
        runId: "33420000-0000-4000-8000-000000000003",
        photos: [{ ordinal: 0, mediaType: "image/jpeg" }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("storagePath");
    expect(rpc).toHaveBeenCalledWith("commit_mobile_item_submission", {
      p_batch_id: "33420000-0000-4000-8000-000000000001",
      p_cleanup_id: "33420000-0000-4000-8000-000000000004",
      p_cost_basis: 12.34,
      p_daily_limit: 15,
      p_idempotency_key: "33420000-0000-4000-8000-000000000001",
      p_per_minute_limit: 20,
      p_photo_identity: {
        kind: "content_sha256_set_v1",
        fingerprint: "b".repeat(64),
      },
      p_photo_receipts: [
        {
          ordinal: 0,
          storage_path: photoReceipts[0].storagePath,
          content_sha256: "a".repeat(64),
          byte_length: 6,
          media_type: "image/jpeg",
        },
      ],
      p_request_fingerprint: "c".repeat(64),
      p_user_id: "user_334",
    });
  });
});
