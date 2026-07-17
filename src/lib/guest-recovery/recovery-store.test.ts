import { describe, expect, it, vi } from "vitest";
import { createSupabaseGuestRecoveryStore } from "./recovery-store";

const encryptedArtifact = {
  version: 1 as const,
  algorithm: "aes-256-gcm" as const,
  keyId: "guest-recovery-v1",
  keyEnvelope: "ZW52ZWxvcGU=",
  nonce: "bm9uY2U=",
  tag: "YXV0aC10YWc=",
  ciphertext: "Y2lwaGVydGV4dA==",
};
const storageManifest = [{
  sourcePath: "guest_fixture/item/front.enc",
  sha256: "a".repeat(64),
  byteLength: 128,
}];

describe("guest encrypted recovery fixed-RPC store", () => {
  it("registers against a durable run without accepting a device clock or TTL", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        outcome: "recoverable",
        recoveryId: "11111111-1111-4111-8111-111111111111",
        itemId: "22222222-2222-4222-8222-222222222222",
        runId: "33333333-3333-4333-8333-333333333333",
        draftId: "44444444-4444-4444-8444-444444444444",
        usableDraftAt: "2026-07-17T12:00:00.000Z",
        expiresAt: "2026-07-18T12:00:00.000Z",
        encryptedArtifact,
        purgeLocalRecovery: false,
      },
      error: null,
    });
    const store = createSupabaseGuestRecoveryStore({ rpc });

    await store.register({
      recoveryId: "11111111-1111-4111-8111-111111111111",
      guestUserId: "guest_fixture",
      pipelineRunId: "33333333-3333-4333-8333-333333333333",
      recoveryTokenHash: "b".repeat(64),
      encryptedArtifact,
      storageManifest,
    });

    expect(rpc).toHaveBeenCalledWith("register_guest_draft_recovery", {
      p_encrypted_artifact: encryptedArtifact,
      p_guest_user_id: "guest_fixture",
      p_pipeline_run_id: "33333333-3333-4333-8333-333333333333",
      p_recovery_id: "11111111-1111-4111-8111-111111111111",
      p_recovery_token_hash: "b".repeat(64),
      p_storage_manifest: storageManifest,
    });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_expires_at");
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_usable_draft_at");
  });
});
