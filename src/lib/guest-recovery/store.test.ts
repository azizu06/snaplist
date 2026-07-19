import { describe, expect, it, vi } from "vitest";
import { GuestClaimIdempotencyConflictError } from "./service";
import { createSupabaseGuestClaimStore } from "./store";

const identity = {
  recoveryId: "11111111-1111-4111-8111-111111111111",
  recoveryTokenHash: "a".repeat(64),
  targetUserId: "user_account",
  idempotencyKey: "66666666-6666-4666-8666-666666666666",
};
const encryptedArtifact = {
  version: 1 as const,
  algorithm: "aes-256-gcm" as const,
  keyId: "guest-recovery-v1",
  keyEnvelope: Buffer.alloc(32, 1).toString("base64"),
  nonce: Buffer.alloc(12, 2).toString("base64"),
  tag: Buffer.alloc(16, 3).toString("base64"),
  ciphertext: Buffer.from("encrypted-draft").toString("base64"),
};
const encryption = {
  algorithm: "aes-256-gcm" as const,
  keyId: encryptedArtifact.keyId,
  nonce: Buffer.alloc(12, 4).toString("base64"),
  tag: Buffer.alloc(16, 5).toString("base64"),
};

describe("guest claim fixed-RPC store", () => {
  it("begins from a verified handoff and never accepts a deadline or ownership payload", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        outcome: "expired",
        itemId: "22222222-2222-4222-8222-222222222222",
        runId: "33333333-3333-4333-8333-333333333333",
        draftId: "44444444-4444-4444-8444-444444444444",
        purgeLocalRecovery: true,
      },
      error: null,
    });
    const store = createSupabaseGuestClaimStore({ rpc });

    await expect(
      store.beginClaim({
        ...identity,
        guestUserId: "guest_fixture",
        leaseSeconds: 300,
      }),
    ).resolves.toMatchObject({ outcome: "expired" });
    expect(rpc).toHaveBeenCalledWith("begin_guest_draft_claim", {
      p_claim_lease_seconds: 300,
      p_guest_user_id: "guest_fixture",
      p_idempotency_key: identity.idempotencyKey,
      p_recovery_id: identity.recoveryId,
      p_recovery_token_hash: identity.recoveryTokenHash,
      p_target_user_id: identity.targetUserId,
    });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("expires_at");
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("item_id");
  });

  it("completes only with the database lease and exact verified object receipts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        outcome: "claimed",
        itemId: "22222222-2222-4222-8222-222222222222",
        runId: "33333333-3333-4333-8333-333333333333",
        draftId: "44444444-4444-4444-8444-444444444444",
        purgeLocalRecovery: true,
        accountRecovery: {
          encryptedArtifact,
          storageManifest: [{
            destinationPath: "user_account/items/front.enc",
            sha256: "b".repeat(64),
            byteLength: 128,
            encryption,
          }],
        },
      },
      error: null,
    });
    const store = createSupabaseGuestClaimStore({ rpc });
    const verifiedObjects = [{
      destinationPath: "user_account/items/front.enc",
      sha256: "b".repeat(64),
      byteLength: 128,
      encryption,
    }];

    await store.completeClaim({
      ...identity,
      claimLeaseToken: "55555555-5555-4555-8555-555555555555",
      verifiedObjects,
    });

    expect(rpc).toHaveBeenCalledWith("complete_guest_draft_claim", {
      p_claim_lease_token: "55555555-5555-4555-8555-555555555555",
      p_recovery_id: identity.recoveryId,
      p_recovery_token_hash: identity.recoveryTokenHash,
      p_target_user_id: identity.targetUserId,
      p_verified_objects: verifiedObjects,
    });
  });

  it("maps a durable principal-key mismatch to the stable claim conflict", async () => {
    const store = createSupabaseGuestClaimStore({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "Guest claim Idempotency-Key is already bound" },
      }),
    });

    await expect(store.beginClaim({
      ...identity,
      guestUserId: "guest_fixture",
      leaseSeconds: 300,
    })).rejects.toBeInstanceOf(GuestClaimIdempotencyConflictError);
  });

  it("requeues cleanup only through the exact recovery and copy lease capability", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const store = createSupabaseGuestClaimStore({ rpc });

    await expect(store.queueCopyCleanup({
      ...identity,
      claimLeaseToken: "55555555-5555-4555-8555-555555555555",
    })).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("queue_guest_claim_copy_cleanup", {
      p_claim_lease_token: "55555555-5555-4555-8555-555555555555",
      p_recovery_id: identity.recoveryId,
      p_recovery_token_hash: identity.recoveryTokenHash,
      p_target_user_id: identity.targetUserId,
    });
  });
});
