import { describe, expect, it, vi } from "vitest";
import { createSupabaseVerifiedGuestCapabilityStore } from "./supabase-store";

describe("Supabase verified guest capability store", () => {
  it("maps issuance and resolution through fixed service-only RPCs without raw credentials", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({
        data: [{
          capability_id: "33200000-0000-4000-8000-000000000002",
          user_id: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
        }],
        error: null,
      });
    const store = createSupabaseVerifiedGuestCapabilityStore({ rpc });
    const digest = Buffer.alloc(32, 0x55);

    await expect(store.issue({
      activatedAt: new Date("2026-07-28T15:00:00.000Z"),
      bearerDigest: digest,
      capabilityId: "33200000-0000-4000-8000-000000000001",
      expiresAt: new Date("2026-07-28T15:30:00.000Z"),
      userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
    })).resolves.toBe(true);
    await expect(store.resolve(digest)).resolves.toEqual({
      capabilityId: "33200000-0000-4000-8000-000000000002",
      userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    expect(rpc.mock.calls).toEqual([
      ["issue_verified_guest_capability", expect.objectContaining({
        p_bearer_digest: `\\x${digest.toString("hex")}`,
        p_capability_id: "33200000-0000-4000-8000-000000000001",
      })],
      ["resolve_verified_guest_capability", {
        p_bearer_digest: `\\x${digest.toString("hex")}`,
      }],
    ]);
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/guestcap_|jwt|private.key/i);
  });
});
