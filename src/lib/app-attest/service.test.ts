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
      appId: "TEAMID1234.dev.snaplist.ios",
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

  it("returns key_not_attested after issuing an assertion challenge for an uncommitted key", async () => {
    const store = new InMemoryAppAttestStore();
    const verifier = fixedVerifier();
    const service = createAppAttestService({
      appId: "TEAMID1234.dev.snaplist.ios",
      challengeBytes: () => FIXED_CHALLENGE,
      challengeId: () => "pending-key-challenge-331",
      challengeTtlMs: 5 * 60 * 1000,
      clock: () => FIXED_NOW,
      environment: "production",
      store,
      verifier,
    });

    const challenge = await service.issueChallenge({
      keyId: FIXED_KEY_ID,
      kind: "assertion",
    });
    const issuedState = store.snapshot();

    await expect(
      service.verifyAssertion({
        assertionObject: "fixed-assertion-object",
        challengeId: challenge.challengeId,
        keyId: FIXED_KEY_ID,
        requestBody: Buffer.from('{"operation":"restore-app-attest-key"}'),
      }),
    ).resolves.toEqual({
      code: "key_not_attested",
      kind: "assertion",
      status: "invalid",
    });
    expect(store.snapshot()).toEqual(issuedState);
    expect(verifier.verifyAssertion).not.toHaveBeenCalled();
  });

  it("commits a cryptographically verified attestation with honestly absent optional metadata", async () => {
    const store = new InMemoryAppAttestStore();
    const verifier = fixedVerifier();
    vi.mocked(verifier.verifyAttestation).mockResolvedValueOnce({
      appId: "TEAMID1234.dev.snaplist.ios",
      bundleVersion: null,
      counter: 0,
      environment: "production",
      keyId: FIXED_KEY_ID,
      publicKey: "fixed-p256-public-key",
      receipt: "fixed-apple-receipt",
      validationCategory: null,
    });
    const service = createAppAttestService({
      appId: "TEAMID1234.dev.snaplist.ios",
      challengeBytes: () => FIXED_CHALLENGE,
      challengeId: () => "extensionless-challenge-331",
      challengeTtlMs: 5 * 60 * 1000,
      clock: () => FIXED_NOW,
      environment: "production",
      store,
      verifier,
    });

    const challenge = await service.issueChallenge({ kind: "attestation" });
    await expect(
      service.verifyAttestation({
        attestationObject: "verified-extensionless-attestation-object",
        challengeId: challenge.challengeId,
        keyId: FIXED_KEY_ID,
      }),
    ).resolves.toMatchObject({
      bundleVersion: null,
      status: "verified",
      validationCategory: null,
    });
    await expect(store.readAttestedKey(FIXED_KEY_ID)).resolves.toMatchObject({
      bundleVersion: null,
      validationCategory: null,
    });
  });

  it("reports only the verifier failure seam while preserving opaque invalid assertion truth", async () => {
    const store = new InMemoryAppAttestStore();
    const verifier = fixedVerifier();
    const verifierError = new Error("Invalid App Attest assertion signature");
    vi.mocked(verifier.verifyAssertion).mockRejectedValueOnce(verifierError);
    const reportVerificationError = vi.fn();
    let challengeSequence = 0;
    const service = createAppAttestService({
      appId: "TEAMID1234.dev.snaplist.ios",
      challengeBytes: () => FIXED_CHALLENGE,
      challengeId: () => `assertion-diagnostic-challenge-${++challengeSequence}`,
      challengeTtlMs: 5 * 60 * 1000,
      clock: () => FIXED_NOW,
      environment: "production",
      reportVerificationError,
      store,
      verifier,
    });

    const attestationChallenge = await service.issueChallenge({ kind: "attestation" });
    await service.verifyAttestation({
      attestationObject: "fixed-attestation-object",
      challengeId: attestationChallenge.challengeId,
      keyId: FIXED_KEY_ID,
    });
    const assertionChallenge = await service.issueChallenge({
      keyId: FIXED_KEY_ID,
      kind: "assertion",
    });

    await expect(service.verifyAssertion({
      assertionObject: "invalid-signature-assertion",
      challengeId: assertionChallenge.challengeId,
      keyId: FIXED_KEY_ID,
      requestBody: Buffer.from('{"operation":"guest-capability.enroll"}'),
    })).resolves.toEqual({
      code: "invalid_evidence",
      kind: "assertion",
      status: "invalid",
    });
    expect(reportVerificationError).toHaveBeenCalledOnce();
    expect(reportVerificationError).toHaveBeenCalledWith("assertion", verifierError);
  });

  it("verifies the exact assertion client data bytes instead of rebuilding their encoding", async () => {
    const store = new InMemoryAppAttestStore();
    const verifier = fixedVerifier();
    vi.mocked(verifier.verifyAssertion).mockResolvedValueOnce({
      appId: "TEAMID1234.dev.snaplist.ios",
      bundleVersion: "1",
      counter: 1,
      environment: "production",
      keyId: FIXED_KEY_ID,
      requestHash: Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          Buffer.from('{"operation":"guest-capability.enroll"}'),
        ),
      ).toString("base64url"),
      validationCategory: 4,
    });
    let challengeSequence = 0;
    const service = createAppAttestService({
      appId: "TEAMID1234.dev.snaplist.ios",
      challengeBytes: () => FIXED_CHALLENGE,
      challengeId: () => `exact-client-data-${++challengeSequence}`,
      challengeTtlMs: 5 * 60 * 1000,
      clock: () => FIXED_NOW,
      environment: "production",
      store,
      verifier,
    });
    const attestationChallenge = await service.issueChallenge({ kind: "attestation" });
    await service.verifyAttestation({
      attestationObject: "fixed-attestation-object",
      challengeId: attestationChallenge.challengeId,
      keyId: FIXED_KEY_ID,
    });
    const assertionChallenge = await service.issueChallenge({
      keyId: FIXED_KEY_ID,
      kind: "assertion",
    });
    const clientData = Buffer.from(
      '{\n  "appId": "TEAMID1234.dev.snaplist.ios", "challenge": "encoding-is-signature-bound"\n}',
      "utf8",
    );

    await service.verifyAssertion({
      assertionObject: "fixed-assertion-object",
      challengeId: assertionChallenge.challengeId,
      clientData,
      keyId: FIXED_KEY_ID,
      requestBody: Buffer.from('{"operation":"guest-capability.enroll"}'),
    });

    expect(verifier.verifyAssertion).toHaveBeenCalledWith(
      expect.objectContaining({ clientData }),
    );
  });
});
