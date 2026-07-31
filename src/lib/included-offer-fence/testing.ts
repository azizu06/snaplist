import { createHash } from "node:crypto";
import type { AppAttestVerificationResult } from "@/lib/app-attest/service";
import type {
  DeviceCheckAdapter,
  DeviceCheckAmbiguousReason,
  DeviceCheckQueryResult,
  DeviceCheckUpdateResult,
} from "./device-check-adapter";
import type { AppAttestRedemptionVerifier } from "./service";

/**
 * Offline stand-in for the #331 assertion service.
 *
 * It reproduces the three properties the fence actually depends on — one-time
 * challenges, a request-bound hash, and a strictly advancing counter — without
 * touching the frozen cryptographic verifier. Test doubles for #331 are the only
 * honest option here: its real fixture is a single fixed assertion and cannot
 * produce the many distinct proofs a redemption flow needs.
 */
export function createFakeAppAttestVerifier(options: {
  appId?: string;
  environment?: "development" | "production";
}): AppAttestRedemptionVerifier & {
  issueChallenge(keyId: string): string;
  attest(keyId: string): void;
} {
  const appId = options.appId ?? "TEAMID1234.dev.snaplist.ios";
  const environment = options.environment ?? "production";
  const openChallenges = new Set<string>();
  const counters = new Map<string, number>();
  let issued = 0;

  return {
    issueChallenge(keyId: string): string {
      issued += 1;
      const challengeId = `challenge-${keyId}-${issued}`;
      openChallenges.add(challengeId);
      return challengeId;
    },

    attest(keyId: string): void {
      counters.set(keyId, 0);
    },

    async verify(input): Promise<AppAttestVerificationResult> {
      const counter = counters.get(input.keyId);
      if (counter === undefined) {
        return { code: "key_not_attested", kind: "assertion", status: "invalid" };
      }
      if (!openChallenges.delete(input.challengeId)) {
        return { code: "challenge_replayed", kind: "assertion", status: "invalid" };
      }
      const requestHash = createHash("sha256")
        .update(input.requestBody)
        .digest("base64url");
      // The client signs the exact bytes it claims; a mismatched assertion object
      // stands in for a body the device never signed.
      if (input.assertionObject !== `signed:${requestHash}`) {
        return { code: "invalid_evidence", kind: "assertion", status: "invalid" };
      }
      counters.set(input.keyId, counter + 1);
      return {
        appId,
        bundleVersion: "1",
        counter: counter + 1,
        environment,
        keyId: input.keyId,
        kind: "assertion",
        requestHash,
        status: "verified",
        validationCategory: 4,
      };
    },
  };
}

/** The exact bytes a device signs, mirrored by the fake verifier above. */
export function fakeAssertionFor(requestBody: Uint8Array): string {
  return `signed:${createHash("sha256").update(requestBody).digest("base64url")}`;
}

/**
 * Deterministic DeviceCheck stand-in. Tokens are opaque strings that resolve to a
 * physical device, which is exactly the real trust model: SnapList never learns
 * the device identity, only Apple's answer about it.
 */
export function createFakeDeviceCheck(options: {
  /** Maps an ephemeral token to the physical device it was minted on. */
  deviceForToken(token: string): string;
  initialBits?: Record<string, { bit0: boolean; bit1: boolean }>;
}): DeviceCheckAdapter & {
  bits(deviceId: string): { bit0: boolean; bit1: boolean } | null;
  seenTokens(): string[];
  failNextQuery(reason: DeviceCheckAmbiguousReason): void;
  failNextUpdate(reason: DeviceCheckAmbiguousReason): void;
  /** Simulates an update that reached Apple even though the caller saw a failure. */
  failNextUpdateAfterApplying(reason: DeviceCheckAmbiguousReason): void;
} {
  const bits = new Map<string, { bit0: boolean; bit1: boolean }>(
    Object.entries(options.initialBits ?? {}),
  );
  const tokens: string[] = [];
  let queryFailure: DeviceCheckAmbiguousReason | null = null;
  let updateFailure: DeviceCheckAmbiguousReason | null = null;
  let updateFailureApplies = false;

  return {
    bits(deviceId) {
      return bits.get(deviceId) ?? null;
    },
    seenTokens() {
      return [...tokens];
    },
    failNextQuery(reason) {
      queryFailure = reason;
    },
    failNextUpdate(reason) {
      updateFailure = reason;
      updateFailureApplies = false;
    },
    failNextUpdateAfterApplying(reason) {
      updateFailure = reason;
      updateFailureApplies = true;
    },

    async queryTwoBits({ deviceToken }): Promise<DeviceCheckQueryResult> {
      tokens.push(deviceToken);
      if (queryFailure) {
        const reason = queryFailure;
        queryFailure = null;
        return { reason, status: "ambiguous" };
      }
      const state = bits.get(options.deviceForToken(deviceToken));
      if (!state) return { bit0: false, bit1: false, status: "resolved" };
      return { bit0: state.bit0, bit1: state.bit1, status: "resolved" };
    },

    async updateTwoBits({
      bit0,
      bit1,
      deviceToken,
    }): Promise<DeviceCheckUpdateResult> {
      tokens.push(deviceToken);
      const deviceId = options.deviceForToken(deviceToken);
      if (updateFailure) {
        const reason = updateFailure;
        const applies = updateFailureApplies;
        updateFailure = null;
        updateFailureApplies = false;
        if (applies) bits.set(deviceId, { bit0, bit1 });
        return { reason, status: "ambiguous" };
      }
      bits.set(deviceId, { bit0, bit1 });
      return { status: "updated" };
    },
  };
}
