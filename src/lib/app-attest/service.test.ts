import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAppAttestStore,
  createAppAttestService,
  type AppAttestCryptographicVerifier,
} from "./service";

const FIXED_NOW = new Date("2026-07-20T20:00:00.000Z");
const FIXED_CHALLENGE = Buffer.from("fixed-app-attest-challenge-331", "utf8");
const FIXED_KEY_ID = Buffer.alloc(32, 0x33).toString("base64");

function fixedVerifier(): AppAttestCryptographicVerifier {
  return {
    verifyAttestation: vi.fn().mockResolvedValue({
      appId: "TEAMID1234.dev.snaplist.ios",
      bundleVersion: "1",
      counter: 0,
      environment: "production",
      keyId: FIXED_KEY_ID,
      publicKey: "fixed-p256-public-key",
      receipt: "fixed-apple-receipt",
      validationCategory: 4,
    }),
    verifyAssertion: vi.fn(),
  };
}

describe("App Attest verification service", () => {
  it("accepts one fixed attestation once and rejects replay without changing state", async () => {
    const store = new InMemoryAppAttestStore();
    const verifier = fixedVerifier();
    const service = createAppAttestService({
      challengeBytes: () => FIXED_CHALLENGE,
      challengeId: () => "challenge-331",
      challengeTtlMs: 5 * 60 * 1000,
      clock: () => FIXED_NOW,
      environment: "production",
      store,
      verifier,
    });

    const challenge = await service.issueChallenge({ kind: "attestation" });
    expect(challenge).toEqual({
      challenge: FIXED_CHALLENGE.toString("base64url"),
      challengeId: "challenge-331",
      expiresAt: "2026-07-20T20:05:00.000Z",
      kind: "attestation",
    });

    const request = {
      attestationObject: "fixed-attestation-object",
      challengeId: challenge.challengeId,
      keyId: FIXED_KEY_ID,
    };
    await expect(service.verifyAttestation(request)).resolves.toEqual({
      appId: "TEAMID1234.dev.snaplist.ios",
      bundleVersion: "1",
      counter: 0,
      environment: "production",
      keyId: FIXED_KEY_ID,
      kind: "attestation",
      status: "verified",
      validationCategory: 4,
    });

    const committedState = store.snapshot();
    await expect(service.verifyAttestation(request)).resolves.toEqual({
      code: "challenge_replayed",
      kind: "attestation",
      status: "invalid",
    });
    expect(store.snapshot()).toEqual(committedState);
    expect(verifier.verifyAttestation).toHaveBeenCalledTimes(1);
  });
});
