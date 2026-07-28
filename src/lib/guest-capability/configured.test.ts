import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const { createClient, createVerifiedGuestOperationTokenSigner, sign } = vi.hoisted(() => ({
  createClient: vi.fn(),
  createVerifiedGuestOperationTokenSigner: vi.fn(),
  sign: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient }));
vi.mock("./signer", () => ({ createVerifiedGuestOperationTokenSigner }));

import { createConfiguredVerifiedGuestPrincipalResolver } from "./configured";

describe("configured verified guest principal resolver", () => {
  it("uses secret authority only for digest resolution and returns a fresh-token closure", async () => {
    const bearerToken = `guestcap_${"A".repeat(43)}`;
    const authority = {
      capabilityId: "33200000-0000-4000-8000-000000000002",
      userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [{
          capability_id: authority.capabilityId,
          user_id: authority.userId,
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          capability_id: authority.capabilityId,
          user_id: authority.userId,
        }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });
    createClient.mockReturnValue({ rpc });
    sign.mockResolvedValueOnce("operation-jwt-1").mockResolvedValueOnce("operation-jwt-2");
    createVerifiedGuestOperationTokenSigner.mockResolvedValue({ sign });
    const resolver = createConfiguredVerifiedGuestPrincipalResolver({
      keyId: "guest-es256-current",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\\nfixed",
      secretKey: "sb_secret_current",
      supabaseURL: "https://project.supabase.co",
    });

    const principal = await resolver.resolve(bearerToken);

    expect(rpc).toHaveBeenCalledWith("resolve_verified_guest_capability", {
      p_bearer_digest: `\\x${createHash("sha256")
        .update(bearerToken)
        .digest("hex")}`,
    });
    expect(principal).toMatchObject({ ...authority, kind: "verifiedGuest" });
    expect(principal).not.toHaveProperty("bearerToken");
    await expect(principal.mintOperationToken()).resolves.toBe("operation-jwt-1");
    await expect(principal.mintOperationToken()).rejects.toThrow(
      /inactive guest capability/i,
    );
    expect(sign).toHaveBeenNthCalledWith(1, authority);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(bearerToken);
  });
});
