import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createVerifiedGuestOperationTokenSigner } from "./signer";

describe("verified guest operation JWT signer", () => {
  it("imports ES256 and derives every bounded Supabase claim from trusted capability state", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const signer = await createVerifiedGuestOperationTokenSigner({
      clock: () => new Date("2026-07-28T15:00:00.000Z"),
      keyId: "guest-es256-2026-07",
      privateKeyPem: await exportPKCS8(privateKey),
      supabaseURL: "https://project.supabase.co",
    });
    const authority = {
      capabilityId: "33200000-0000-4000-8000-000000000002",
      userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
    };

    const first = await signer.sign(authority);
    const second = await signer.sign(authority);
    const verified = await jwtVerify(first, publicKey, {
      algorithms: ["ES256"],
      audience: "authenticated",
      currentDate: new Date("2026-07-28T15:00:30.000Z"),
      issuer: "https://project.supabase.co/auth/v1",
    });

    expect(verified.protectedHeader).toMatchObject({
      alg: "ES256",
      kid: "guest-es256-2026-07",
      typ: "JWT",
    });
    expect(verified.payload).toMatchObject({
      actor: "verified_guest",
      aud: "authenticated",
      cap_id: authority.capabilityId,
      role: "authenticated",
      snaplist_operation_channel: "verified_guest_publishable",
      sub: authority.userId,
    });
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBeLessThanOrEqual(60);
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBeGreaterThan(0);
    expect(verified.payload.jti).not.toBe((await jwtVerify(second, publicKey, {
      currentDate: new Date("2026-07-28T15:00:30.000Z"),
    })).payload.jti);
  });
});
