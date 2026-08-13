import "server-only";

import {
  createHash,
  randomBytes as secureRandomBytes,
  randomUUID as secureRandomUUID,
} from "node:crypto";
import type { AppAttestVerificationResult } from "@/lib/app-attest/service";
import {
  GUEST_CAPABILITY_TOKEN_PREFIX,
  guestCapabilityBearerTokenPattern,
} from "./token-prefix";

const CAPABILITY_LIFETIME_MS = 30 * 60 * 1_000;
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const BEARER_TOKEN_PATTERN = guestCapabilityBearerTokenPattern(
  GUEST_CAPABILITY_TOKEN_PREFIX,
);

export interface VerifiedGuestCapabilityAuthority {
  capabilityId: string;
  userId: string;
}

export interface VerifiedGuestCapabilityStore {
  issue(input: {
    activatedAt: Date;
    bearerDigest: Buffer;
    capabilityId: string;
    expiresAt: Date;
    userId: string;
  }): Promise<boolean>;
  resolve(bearerDigest: Buffer): Promise<VerifiedGuestCapabilityAuthority | null>;
}

type VerifiedAssertion = Extract<
  AppAttestVerificationResult,
  { kind: "assertion"; status: "verified" }
>;

export function createVerifiedGuestCapabilityService(options: {
  clock?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  randomUUID?: () => string;
  store: VerifiedGuestCapabilityStore;
}) {
  const clock = options.clock ?? (() => new Date());
  const makeBytes = options.randomBytes ?? secureRandomBytes;
  const makeUuid = options.randomUUID ?? secureRandomUUID;

  return {
    async issue(assertion: VerifiedAssertion) {
      const activatedAt = clock();
      const expiresAt = new Date(activatedAt.getTime() + CAPABILITY_LIFETIME_MS);
      const bearerToken = `${GUEST_CAPABILITY_TOKEN_PREFIX}${Buffer.from(makeBytes(32)).toString("base64url")}`;
      const userId = `guest_${createHash("sha256")
        .update(assertion.appId)
        .update("\0")
        .update(assertion.keyId)
        .digest("hex")
        .slice(0, 48)}`;
      const issued = await options.store.issue({
        activatedAt,
        bearerDigest: createHash("sha256").update(bearerToken).digest(),
        capabilityId: makeUuid(),
        expiresAt,
        userId,
      });
      if (issued !== true) throw new Error("Verified guest capability issuance failed.");
      return {
        bearerToken,
        expiresAt: expiresAt.toISOString(),
        refreshAfter: new Date(expiresAt.getTime() - REFRESH_WINDOW_MS).toISOString(),
      };
    },

    async resolve(bearerToken: string): Promise<VerifiedGuestCapabilityAuthority> {
      if (!BEARER_TOKEN_PATTERN.test(bearerToken)) {
        throw new Error("Invalid guest capability.");
      }
      const authority = await options.store.resolve(
        createHash("sha256").update(bearerToken).digest(),
      );
      if (!authority) throw new Error("Inactive guest capability.");
      return authority;
    },
  };
}
