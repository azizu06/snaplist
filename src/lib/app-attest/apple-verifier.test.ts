import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAppleAppAttestVerifier } from "./apple-verifier";

interface AppleValidationFixture {
  appId: string;
  appleRootCertificatePem: string;
  attestationObject: string;
  challenge: string;
  environment: "production";
  expected: {
    bundleVersion: string;
    counter: 0;
    validationCategory: number;
  };
  keyId: string;
  validationTime: string;
}

interface AssertionFixture {
  appId: string;
  assertionObject: string;
  challenge: string;
  clientData: string;
  doubleHashedAssertionObject: string;
  environment: "production";
  expected: {
    bundleVersion: string;
    counter: number;
    validationCategory: number;
  };
  keyId: string;
  legacyAssertionObject: string;
  publicKey: string;
  requestHash: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/apple-attestation-validation-guide.json", import.meta.url),
    "utf8",
  ),
) as AppleValidationFixture;
const assertionFixture = JSON.parse(
  readFileSync(new URL("./fixtures/fixed-assertion.json", import.meta.url), "utf8"),
) as AssertionFixture;

describe("Apple App Attest cryptographic verifier", () => {
  it("validates Apple's fixed production attestation fixture", async () => {
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: fixture.appleRootCertificatePem,
    });

    const evidence = await verifier.verifyAttestation({
      appId: fixture.appId,
      attestationObject: fixture.attestationObject,
      clientDataHash: Buffer.from(fixture.challenge, "utf8"),
      environment: fixture.environment,
      keyId: fixture.keyId,
      now: new Date(fixture.validationTime),
    });

    expect(evidence).toMatchObject({
      appId: fixture.appId,
      bundleVersion: fixture.expected.bundleVersion,
      counter: fixture.expected.counter,
      environment: fixture.environment,
      keyId: fixture.keyId,
      validationCategory: fixture.expected.validationCategory,
    });
    expect(evidence.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(Buffer.from(evidence.receipt, "base64").byteLength).toBeGreaterThan(0);
  });

  it.each([
    ["tampered challenge", { clientDataHash: Buffer.from("tampered", "utf8") }],
    ["wrong app ID", { appId: "1234567890.com.example.tampered" }],
    ["wrong key ID", { keyId: Buffer.alloc(32, 0x7f).toString("base64") }],
    ["wrong environment", { environment: "development" as const }],
    ["expired certificate", { now: new Date("2026-04-24T00:00:00.000Z") }],
  ])("rejects %s in Apple's fixed attestation", async (_name, override) => {
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: fixture.appleRootCertificatePem,
    });
    await expect(
      verifier.verifyAttestation({
        appId: fixture.appId,
        attestationObject: fixture.attestationObject,
        clientDataHash: Buffer.from(fixture.challenge, "utf8"),
        environment: fixture.environment,
        keyId: fixture.keyId,
        now: new Date(fixture.validationTime),
        ...override,
      }),
    ).rejects.toThrow();
  });

  it("validates a fixed request-bound assertion signature and counter", async () => {
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: fixture.appleRootCertificatePem,
    });

    await expect(
      verifier.verifyAssertion({
        appId: assertionFixture.appId,
        assertionObject: assertionFixture.assertionObject,
        attestedBundleVersion: assertionFixture.expected.bundleVersion,
        attestedValidationCategory: assertionFixture.expected.validationCategory,
        challenge: Buffer.from(assertionFixture.challenge, "base64url"),
        clientData: Buffer.from(assertionFixture.clientData, "base64"),
        environment: assertionFixture.environment,
        keyId: assertionFixture.keyId,
        now: new Date("2026-07-20T20:00:00.000Z"),
        publicKey: assertionFixture.publicKey,
      }),
    ).resolves.toEqual({
      appId: assertionFixture.appId,
      bundleVersion: assertionFixture.expected.bundleVersion,
      counter: assertionFixture.expected.counter,
      environment: assertionFixture.environment,
      keyId: assertionFixture.keyId,
      requestHash: assertionFixture.requestHash,
      validationCategory: assertionFixture.expected.validationCategory,
    });
  });

  it("rejects a fixture signed over a prehashed assertion digest", async () => {
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: fixture.appleRootCertificatePem,
    });

    await expect(
      verifier.verifyAssertion({
        appId: assertionFixture.appId,
        assertionObject: assertionFixture.doubleHashedAssertionObject,
        attestedBundleVersion: assertionFixture.expected.bundleVersion,
        attestedValidationCategory: assertionFixture.expected.validationCategory,
        challenge: Buffer.from(assertionFixture.challenge, "base64url"),
        clientData: Buffer.from(assertionFixture.clientData, "base64"),
        environment: assertionFixture.environment,
        keyId: assertionFixture.keyId,
        now: new Date("2026-07-20T20:00:00.000Z"),
        publicKey: assertionFixture.publicKey,
      }),
    ).rejects.toThrow("Invalid App Attest assertion signature");
  });

  it("validates an assertion from supported OS versions without extensions", async () => {
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: fixture.appleRootCertificatePem,
    });
    await expect(
      verifier.verifyAssertion({
        appId: assertionFixture.appId,
        assertionObject: assertionFixture.legacyAssertionObject,
        attestedBundleVersion: assertionFixture.expected.bundleVersion,
        attestedValidationCategory: assertionFixture.expected.validationCategory,
        challenge: Buffer.from(assertionFixture.challenge, "base64url"),
        clientData: Buffer.from(assertionFixture.clientData, "base64"),
        environment: assertionFixture.environment,
        keyId: assertionFixture.keyId,
        now: new Date("2026-07-20T20:00:00.000Z"),
        publicKey: assertionFixture.publicKey,
      }),
    ).resolves.toMatchObject({
      bundleVersion: assertionFixture.expected.bundleVersion,
      counter: assertionFixture.expected.counter,
      validationCategory: assertionFixture.expected.validationCategory,
    });
  });

  it("rejects a tampered request-bound assertion", async () => {
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: fixture.appleRootCertificatePem,
    });
    await expect(
      verifier.verifyAssertion({
        appId: assertionFixture.appId,
        assertionObject: assertionFixture.assertionObject,
        attestedBundleVersion: assertionFixture.expected.bundleVersion,
        attestedValidationCategory: assertionFixture.expected.validationCategory,
        challenge: Buffer.from(assertionFixture.challenge, "base64url"),
        clientData: Buffer.from("tampered-client-data", "utf8"),
        environment: assertionFixture.environment,
        keyId: assertionFixture.keyId,
        now: new Date("2026-07-20T20:00:00.000Z"),
        publicKey: assertionFixture.publicKey,
      }),
    ).rejects.toThrow();
  });
});
