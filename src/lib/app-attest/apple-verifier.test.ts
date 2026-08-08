import "reflect-metadata";

import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BasicConstraintsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { decode, Encoder } from "cbor-x";
import { describe, expect, it } from "vitest";
import {
  createAppleAppAttestVerifier,
  parseAppAttestAuthenticatorData,
} from "./apple-verifier";

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
  preNonceAssertionObject: string;
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

function sha256(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

async function createExtensionlessAttestationFixture() {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
  const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" } as const;
  const rootKeys = await webcrypto.subtle.generateKey(
    algorithm,
    true,
    ["sign", "verify"],
  );
  const intermediateKeys = await webcrypto.subtle.generateKey(
    algorithm,
    true,
    ["sign", "verify"],
  );
  const leafKeys = await webcrypto.subtle.generateKey(
    algorithm,
    true,
    ["sign", "verify"],
  );
  const notBefore = new Date("2026-08-08T00:00:00.000Z");
  const notAfter = new Date("2027-08-08T00:00:00.000Z");
  const root = await X509CertificateGenerator.createSelfSigned({
    extensions: [
      new BasicConstraintsExtension(true, 1, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true),
    ],
    keys: rootKeys,
    name: "CN=SnapList App Attest Test Root",
    notAfter,
    notBefore,
    signingAlgorithm,
  });
  const intermediate = await X509CertificateGenerator.create({
    extensions: [
      new BasicConstraintsExtension(true, 0, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true),
    ],
    issuer: root.subject,
    notAfter,
    notBefore,
    publicKey: intermediateKeys.publicKey,
    signingAlgorithm,
    signingKey: rootKeys.privateKey,
    subject: "CN=SnapList App Attest Test Intermediate",
  });
  const publicJwk = await webcrypto.subtle.exportKey("jwk", leafKeys.publicKey);
  const x = Buffer.from(publicJwk.x!, "base64url");
  const y = Buffer.from(publicJwk.y!, "base64url");
  const rawPublicKey = Buffer.concat([Buffer.from([0x04]), x, y]);
  const keyId = sha256(rawPublicKey);
  const coseKey = new Encoder({ mapsAsObjects: false }).encode(
    new Map<number, number | Buffer>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
  expect(coseKey).toHaveLength(77);
  const appId = "TEAMID1234.dev.snaplist.ios";
  const authData = Buffer.concat([
    sha256(Buffer.from(appId, "utf8")),
    Buffer.from([0x40]),
    Buffer.alloc(4),
    Buffer.concat([Buffer.from("appattest", "ascii"), Buffer.alloc(7)]),
    Buffer.from([0x00, 0x20]),
    keyId,
    coseKey,
  ]);
  expect(authData).toHaveLength(164);
  const clientDataHash = Buffer.alloc(32, 0x42);
  const nonce = sha256(Buffer.concat([authData, clientDataHash]));
  const nonceExtension = Buffer.concat([
    Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]),
    nonce,
  ]);
  const leaf = await X509CertificateGenerator.create({
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new Extension("1.2.840.113635.100.8.2", false, nonceExtension),
    ],
    issuer: intermediate.subject,
    notAfter,
    notBefore,
    publicKey: leafKeys.publicKey,
    signingAlgorithm,
    signingKey: intermediateKeys.privateKey,
    subject: "CN=SnapList App Attest Test Leaf",
  });
  const attestationObject = new Encoder({ useRecords: false }).encode({
    attStmt: {
      receipt: Buffer.from("test-apple-receipt", "utf8"),
      x5c: [Buffer.from(leaf.rawData), Buffer.from(intermediate.rawData)],
    },
    authData,
    fmt: "apple-appattest",
  });

  return {
    appId,
    attestationObject: Buffer.from(attestationObject).toString("base64"),
    clientDataHash,
    keyId: keyId.toString("base64"),
    rootPem: root.toString("pem"),
  };
}

describe("Apple App Attest cryptographic verifier", () => {
  it("accepts standard 164-byte attestation authData without optional metadata extensions", () => {
    const decoded = decode(Buffer.from(fixture.attestationObject, "base64")) as {
      authData: Uint8Array;
    };
    const standardAuthData = Buffer.from(decoded.authData).subarray(0, 164);
    standardAuthData[32] &= 0x7f;

    expect(standardAuthData).toHaveLength(164);
    expect(parseAppAttestAuthenticatorData(standardAuthData)).toMatchObject({
      bundleVersion: null,
      counter: 0,
      validationCategory: null,
    });
  });

  it("rejects an authenticator that claims extensions without carrying extension bytes", () => {
    const decoded = decode(Buffer.from(fixture.attestationObject, "base64")) as {
      authData: Uint8Array;
    };
    const malformedAuthData = Buffer.from(decoded.authData).subarray(0, 164);
    malformedAuthData[32] |= 0x80;

    expect(() => parseAppAttestAuthenticatorData(malformedAuthData)).toThrow(
      "Invalid App Attest extension framing",
    );
  });

  it("verifies a coherent signed extensionless attestation at the public cryptographic seam", async () => {
    const extensionless = await createExtensionlessAttestationFixture();
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: extensionless.rootPem,
    });

    await expect(
      verifier.verifyAttestation({
        appId: extensionless.appId,
        attestationObject: extensionless.attestationObject,
        clientDataHash: extensionless.clientDataHash,
        environment: "production",
        keyId: extensionless.keyId,
        now: new Date("2026-08-08T13:30:00.000Z"),
      }),
    ).resolves.toMatchObject({
      appId: extensionless.appId,
      bundleVersion: null,
      counter: 0,
      environment: "production",
      keyId: extensionless.keyId,
      validationCategory: null,
    });
  });

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

  it("rejects a fixture signed before deriving Apple's assertion nonce", async () => {
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: fixture.appleRootCertificatePem,
    });

    await expect(
      verifier.verifyAssertion({
        appId: assertionFixture.appId,
        assertionObject: assertionFixture.preNonceAssertionObject,
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

  it("continues an extensionless assertion from an honestly extensionless attestation", async () => {
    const verifier = createAppleAppAttestVerifier({
      appleRootCertificatePem: fixture.appleRootCertificatePem,
    });
    await expect(
      verifier.verifyAssertion({
        appId: assertionFixture.appId,
        assertionObject: assertionFixture.legacyAssertionObject,
        attestedBundleVersion: null,
        attestedValidationCategory: null,
        challenge: Buffer.from(assertionFixture.challenge, "base64url"),
        clientData: Buffer.from(assertionFixture.clientData, "base64"),
        environment: assertionFixture.environment,
        keyId: assertionFixture.keyId,
        now: new Date("2026-07-20T20:00:00.000Z"),
        publicKey: assertionFixture.publicKey,
      }),
    ).resolves.toMatchObject({
      bundleVersion: null,
      counter: assertionFixture.expected.counter,
      validationCategory: null,
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
