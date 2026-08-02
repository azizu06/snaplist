import { describe, expect, it, vi } from "vitest";
import { createSupabaseGuestClaimHandoffStore } from "./guest-handoff-supabase-store";

describe("guest claim handoff fixed-RPC store", () => {
  it("persists only token digest and verified binding fields", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const store = createSupabaseGuestClaimHandoffStore({ rpc });

    await expect(store.issue({
      appId: "TEAMID1234.dev.snaplist.ios",
      environment: "production",
      expiresAt: new Date("2026-08-02T16:05:00.000Z"),
      guestUserId: `guest_${"a".repeat(48)}`,
      handoffId: "11111111-1111-4111-8111-111111111111",
      issuedAt: new Date("2026-08-02T16:00:00.000Z"),
      keyId: Buffer.alloc(32, 1).toString("base64"),
      photoSetFingerprint: "b".repeat(64),
      recoveryId: "22222222-2222-4222-8222-222222222222",
      recoveryTokenHash: "c".repeat(64),
      tokenDigest: Buffer.alloc(32, 4),
    })).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("issue_guest_claim_handoff", {
      p_app_id: "TEAMID1234.dev.snaplist.ios",
      p_environment: "production",
      p_expires_at: "2026-08-02T16:05:00.000Z",
      p_guest_user_id: `guest_${"a".repeat(48)}`,
      p_handoff_id: "11111111-1111-4111-8111-111111111111",
      p_issued_at: "2026-08-02T16:00:00.000Z",
      p_key_id: Buffer.alloc(32, 1).toString("base64"),
      p_photo_set_fingerprint: "b".repeat(64),
      p_recovery_id: "22222222-2222-4222-8222-222222222222",
      p_recovery_token_hash: "c".repeat(64),
      p_token_digest: `\\x${"04".repeat(32)}`,
    });
  });

  it("returns only the verified recovery identity consumed by the claim handler", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        guest_user_id: `guest_${"a".repeat(48)}`,
        recovery_id: "22222222-2222-4222-8222-222222222222",
        recovery_token_hash: "c".repeat(64),
      }],
      error: null,
    });
    const store = createSupabaseGuestClaimHandoffStore({ rpc });

    await expect(store.consume({
      appId: "TEAMID1234.dev.snaplist.ios",
      environment: "production",
      handoffId: "11111111-1111-4111-8111-111111111111",
      now: new Date("2026-08-02T16:00:00.000Z"),
      tokenDigest: Buffer.alloc(32, 4),
    })).resolves.toEqual({
      guestUserId: `guest_${"a".repeat(48)}`,
      recoveryId: "22222222-2222-4222-8222-222222222222",
      recoveryTokenHash: "c".repeat(64),
    });
    expect(rpc).toHaveBeenCalledWith("consume_guest_claim_handoff", {
      p_app_id: "TEAMID1234.dev.snaplist.ios",
      p_environment: "production",
      p_handoff_id: "11111111-1111-4111-8111-111111111111",
      p_token_digest: `\\x${"04".repeat(32)}`,
    });
  });
});
