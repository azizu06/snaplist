import "server-only";

import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import type { VerifiedGuestCapabilityAuthority } from "./service";

const OPERATION_TOKEN_LIFETIME_SECONDS = 60;

export async function createVerifiedGuestOperationTokenSigner(input: {
  clock?: () => Date;
  keyId: string;
  privateKeyPem: string;
  supabaseURL: string;
}) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.keyId)) {
    throw new Error("Verified guest signing key id is invalid.");
  }
  const privateKey = await importPKCS8(
    input.privateKeyPem.replaceAll("\\n", "\n").trim(),
    "ES256",
  );
  const issuer = new URL("/auth/v1", `${input.supabaseURL.replace(/\/+$/, "")}/`).toString()
    .replace(/\/$/, "");
  const clock = input.clock ?? (() => new Date());

  return {
    async sign(authority: VerifiedGuestCapabilityAuthority): Promise<string> {
      const issuedAt = Math.floor(clock().getTime() / 1_000);
      return new SignJWT({
        actor: "verified_guest",
        cap_id: authority.capabilityId,
        role: "authenticated",
        snaplist_operation_channel: "verified_guest_publishable",
      })
        .setProtectedHeader({ alg: "ES256", kid: input.keyId, typ: "JWT" })
        .setAudience("authenticated")
        .setExpirationTime(issuedAt + OPERATION_TOKEN_LIFETIME_SECONDS)
        .setIssuedAt(issuedAt)
        .setIssuer(issuer)
        .setJti(randomUUID())
        .setSubject(authority.userId)
        .sign(privateKey);
    },
  };
}
