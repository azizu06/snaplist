import { describe, expect, it, vi } from "vitest";
import {
  GuestClaimAllowanceInFlightError,
  GuestClaimAllowanceSpentError,
  GuestClaimIdempotencyConflictError,
} from "./service";
import { createSupabaseGuestClaimStore } from "./store";

const identity = {
  recoveryId: "11111111-1111-4111-8111-111111111111",
  recoveryTokenHash: "a".repeat(64),
  targetUserId: "user_account",
  idempotencyKey: "66666666-6666-4666-8666-666666666666",
};
const completionToken = "c".repeat(64);
const completionTokenHash = "d".repeat(64);
function verifiedObject(destinationPath: string, ordinal = 0) {
  return {
    destinationPath,
    sourceSha256: ordinal.toString(16).repeat(64),
    sourceByteLength: 165 + ordinal,
    plaintextSha256: (ordinal + 1).toString(16).repeat(64),
    plaintextByteLength: 128 + ordinal,
    mediaType: "image/jpeg" as const,
  };
}

describe("guest claim fixed-RPC store", () => {
  it("completes a five-object claim through the fixed lease capability", async () => {
    const verifiedObjects = Array.from({ length: 5 }, (_, ordinal) =>
      verifiedObject(`user_account/items/photo-${ordinal}.jpg`, ordinal));
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

    await store.completeClaim({
      ...identity,
      claimLeaseToken: "55555555-5555-4555-8555-555555555555",
      completionToken,
      verifiedObjects,
    });

    expect(rpc).toHaveBeenCalledWith(
      "complete_guest_draft_claim_with_plaintext",
      expect.objectContaining({ p_verified_objects: verifiedObjects }),
    );
  });

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
        completionTokenHash,
      }),
    ).resolves.toMatchObject({ outcome: "expired" });
    expect(rpc).toHaveBeenCalledWith("begin_guest_draft_claim_with_plaintext", {
      p_claim_lease_seconds: 300,
      p_completion_token_hash: completionTokenHash,
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
      },
      error: null,
    });
    const store = createSupabaseGuestClaimStore({ rpc });
    const verifiedObjects = [verifiedObject("user_account/items/front.jpg", 11)];

    await store.completeClaim({
      ...identity,
      claimLeaseToken: "55555555-5555-4555-8555-555555555555",
      completionToken,
      verifiedObjects,
    });

    expect(rpc).toHaveBeenCalledWith("complete_guest_draft_claim_with_plaintext", {
      p_claim_lease_token: "55555555-5555-4555-8555-555555555555",
      p_completion_token: completionToken,
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
      completionTokenHash,
    })).rejects.toBeInstanceOf(GuestClaimIdempotencyConflictError);
  });

  it.each([
    [
      "Account included credit is already spent on another run",
      GuestClaimAllowanceSpentError,
    ],
    [
      "Account included credit is reserved by a run in flight",
      GuestClaimAllowanceInFlightError,
    ],
  ])("carries the %s denial to the caller as its own outcome", async (
    message,
    expected,
  ) => {
    const store = createSupabaseGuestClaimStore({
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message } }),
    });

    const calls = [
      () => store.beginClaim({
        ...identity,
        guestUserId: "guest_fixture",
        leaseSeconds: 300,
        completionTokenHash,
      }),
      () => store.completeClaim({
        ...identity,
        claimLeaseToken: "55555555-5555-4555-8555-555555555555",
        completionToken,
        verifiedObjects: [verifiedObject("user_account/items/front.jpg", 11)],
      }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(expected);
      await expect(call()).rejects.not.toBeInstanceOf(
        GuestClaimIdempotencyConflictError,
      );
    }
  });

  it("keys the allowance denials on SQLSTATE, so a reworded message still maps", async () => {
    const store = createSupabaseGuestClaimStore({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "SL001", message: "some future rewording" },
      }),
    });

    await expect(store.beginClaim({
      ...identity,
      guestUserId: "guest_fixture",
      leaseSeconds: 300,
      completionTokenHash,
    })).rejects.toBeInstanceOf(GuestClaimAllowanceSpentError);
  });

  it("never reads a generic unique violation as an allowance denial", async () => {
    // 23505 is raised by the idempotency bind and by any real constraint, so it
    // is not safe to dispatch on. Only the two dedicated codes are.
    const store = createSupabaseGuestClaimStore({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      }),
    });

    const rejection = store.beginClaim({
      ...identity,
      guestUserId: "guest_fixture",
      leaseSeconds: 300,
      completionTokenHash,
    });
    await expect(rejection).rejects.not.toBeInstanceOf(GuestClaimAllowanceSpentError);
    await expect(rejection).rejects.not.toBeInstanceOf(GuestClaimAllowanceInFlightError);
    await expect(rejection).rejects.not.toBeInstanceOf(
      GuestClaimIdempotencyConflictError,
    );
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
      p_idempotency_key: identity.idempotencyKey,
      p_recovery_id: identity.recoveryId,
      p_recovery_token_hash: identity.recoveryTokenHash,
      p_target_user_id: identity.targetUserId,
    });
  });
});
