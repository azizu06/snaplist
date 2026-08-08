import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAppleAppAttestVerifier } from "./apple-verifier";
import { InMemoryAppAttestStore, createAppAttestService } from "./service";

interface AssertionFixture {
  appId: string;
  assertionObject: string;
  legacyAssertionObject: string;
  challenge: string;
  environment: "production";
  expected: {
    bundleVersion: string;
    counter: number;
    validationCategory: number;
  };
  keyId: string;
  publicKey: string;
  requestBody: string;
  requestHash: string;
}

const assertion = JSON.parse(
  readFileSync(new URL("./fixtures/fixed-assertion.json", import.meta.url), "utf8"),
) as AssertionFixture;
const appleFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/apple-attestation-validation-guide.json", import.meta.url),
    "utf8",
  ),
) as { appleRootCertificatePem: string };

describe("App Attest assertion service", () => {
  it("accepts one request-bound assertion and rejects replay without advancing the counter", async () => {
    const now = new Date("2026-07-20T20:00:00.000Z");
    const store = new InMemoryAppAttestStore();
    await store.commitAttestation({
      evidence: {
        appId: assertion.appId,
        bundleVersion: "1",
        counter: 0,
        environment: assertion.environment,
        keyId: assertion.keyId,
        publicKey: assertion.publicKey,
        receipt: "fixed-receipt",
        validationCategory: 4,
      },
      now,
    });
    const service = createAppAttestService({
      appId: assertion.appId,
      challengeBytes: () => Buffer.from(assertion.challenge, "base64url"),
      challengeId: () => "assertion-challenge-331",
      challengeTtlMs: 5 * 60 * 1000,
      clock: () => now,
      environment: assertion.environment,
      store,
      verifier: createAppleAppAttestVerifier({
        appleRootCertificatePem: appleFixture.appleRootCertificatePem,
      }),
    });
    const challenge = await service.issueChallenge({
      keyId: assertion.keyId,
      kind: "assertion",
    });
    const request = {
      assertionObject: assertion.assertionObject,
      challengeId: challenge.challengeId,
      keyId: assertion.keyId,
      requestBody: Buffer.from(assertion.requestBody, "base64"),
    };

    await expect(service.verifyAssertion(request)).resolves.toEqual({
      appId: assertion.appId,
      bundleVersion: assertion.expected.bundleVersion,
      counter: assertion.expected.counter,
      environment: assertion.environment,
      keyId: assertion.keyId,
      kind: "assertion",
      requestHash: assertion.requestHash,
      status: "verified",
      validationCategory: assertion.expected.validationCategory,
    });

    const committedState = store.snapshot();
    await expect(service.verifyAssertion(request)).resolves.toEqual({
      code: "challenge_replayed",
      kind: "assertion",
      status: "invalid",
    });
    expect(store.snapshot()).toEqual(committedState);
  });

  it("continues a signed extensionless assertion from an extensionless attested key", async () => {
    const now = new Date("2026-07-20T20:00:00.000Z");
    const store = new InMemoryAppAttestStore();
    await store.commitAttestation({
      evidence: {
        appId: assertion.appId,
        bundleVersion: null,
        counter: 0,
        environment: assertion.environment,
        keyId: assertion.keyId,
        publicKey: assertion.publicKey,
        receipt: "fixed-receipt",
        validationCategory: null,
      },
      now,
    });
    const service = createAppAttestService({
      appId: assertion.appId,
      challengeBytes: () => Buffer.from(assertion.challenge, "base64url"),
      challengeId: () => "extensionless-assertion-challenge-331",
      challengeTtlMs: 5 * 60 * 1000,
      clock: () => now,
      environment: assertion.environment,
      store,
      verifier: createAppleAppAttestVerifier({
        appleRootCertificatePem: appleFixture.appleRootCertificatePem,
      }),
    });
    const challenge = await service.issueChallenge({
      keyId: assertion.keyId,
      kind: "assertion",
    });

    await expect(
      service.verifyAssertion({
        assertionObject: assertion.legacyAssertionObject,
        challengeId: challenge.challengeId,
        keyId: assertion.keyId,
        requestBody: Buffer.from(assertion.requestBody, "base64"),
      }),
    ).resolves.toMatchObject({
      bundleVersion: null,
      counter: assertion.expected.counter,
      status: "verified",
      validationCategory: null,
    });
  });
});
