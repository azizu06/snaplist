import "server-only";
import "reflect-metadata";

import {
  X509Certificate as NodeX509Certificate,
  createHash,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { X509Certificate } from "@peculiar/x509";
import { decode } from "cbor-x";
import type {
  AppAttestCryptographicVerifier,
  AppAttestEnvironment,
  VerifiedAttestationEvidence,
} from "./service";

const APP_ATTEST_NONCE_OID = "1.2.840.113635.100.8.2";
export const APPLE_APP_ATTEST_ROOT_CA_PEM = "-----BEGIN CERTIFICATE-----\nMIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw\nJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK\nQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa\nFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv\nbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y\nbmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh\nNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au\nYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/\nMB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw\nCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn\n53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV\noyFraWVIyd/dganmrduC1bmTBGwD\n-----END CERTIFICATE-----";
const DEVELOPMENT_AAGUID = Buffer.from("appattestdevelop", "ascii");
const PRODUCTION_AAGUID = Buffer.concat([
  Buffer.from("appattest", "ascii"),
  Buffer.alloc(7),
]);

interface DecodedAttestation {
  attStmt: {
    receipt: Buffer;
    x5c: Buffer[];
  };
  authData: Buffer;
  fmt: string;
}

function requireBuffer(value: unknown, name: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`Invalid App Attest ${name}`);
  }
  return Buffer.from(value);
}

function decodeAttestation(value: string): DecodedAttestation {
  let decoded: unknown;
  try {
    decoded = decode(Buffer.from(value, "base64"));
  } catch {
    throw new Error("Invalid App Attest CBOR");
  }
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid App Attest object");
  }

  const candidate = decoded as Record<string, unknown>;
  if (candidate.fmt !== "apple-appattest") {
    throw new Error("Invalid App Attest format");
  }
  if (!candidate.attStmt || typeof candidate.attStmt !== "object") {
    throw new Error("Invalid App Attest statement");
  }
  const statement = candidate.attStmt as Record<string, unknown>;
  if (!Array.isArray(statement.x5c) || statement.x5c.length !== 2) {
    throw new Error("Invalid App Attest certificate chain");
  }

  return {
    attStmt: {
      receipt: requireBuffer(statement.receipt, "receipt"),
      x5c: statement.x5c.map((certificate, index) =>
        requireBuffer(certificate, `certificate ${index}`),
      ),
    },
    authData: requireBuffer(candidate.authData, "authenticator data"),
    fmt: candidate.fmt,
  };
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function sha256(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function verifyCertificateChain(input: {
  leafDer: Buffer;
  intermediateDer: Buffer;
  now: Date;
  rootPem: string;
}): NodeX509Certificate {
  const leaf = new NodeX509Certificate(input.leafDer);
  const intermediate = new NodeX509Certificate(input.intermediateDer);
  const root = new NodeX509Certificate(input.rootPem);

  for (const certificate of [leaf, intermediate, root]) {
    const validFrom = new Date(certificate.validFrom);
    const validTo = new Date(certificate.validTo);
    if (input.now < validFrom || input.now > validTo) {
      throw new Error("Expired App Attest certificate");
    }
  }
  if (
    !leaf.checkIssued(intermediate) ||
    !leaf.verify(intermediate.publicKey) ||
    !intermediate.checkIssued(root) ||
    !intermediate.verify(root.publicKey) ||
    !root.checkIssued(root) ||
    !root.verify(root.publicKey)
  ) {
    throw new Error("Untrusted App Attest certificate chain");
  }
  return leaf;
}

function readDerLength(value: Buffer, offset: number): {
  length: number;
  nextOffset: number;
} {
  const first = value[offset];
  if (first === undefined) throw new Error("Invalid DER length");
  if ((first & 0x80) === 0) return { length: first, nextOffset: offset + 1 };
  const byteCount = first & 0x7f;
  if (byteCount === 0 || byteCount > 4 || offset + byteCount >= value.length) {
    throw new Error("Invalid DER length");
  }
  let length = 0;
  for (let index = 0; index < byteCount; index += 1) {
    length = (length << 8) | value[offset + 1 + index]!;
  }
  return { length, nextOffset: offset + 1 + byteCount };
}

function unwrapDer(value: Buffer, expectedTag: number): Buffer {
  if (value[0] !== expectedTag) throw new Error("Invalid DER tag");
  const { length, nextOffset } = readDerLength(value, 1);
  if (nextOffset + length !== value.length) throw new Error("Invalid DER value");
  return value.subarray(nextOffset);
}

function certificateNonce(leafDer: Buffer): Buffer {
  const certificate = new X509Certificate(Uint8Array.from(leafDer).buffer);
  const extension = certificate.getExtension(APP_ATTEST_NONCE_OID);
  if (!extension) throw new Error("Missing App Attest nonce extension");
  const sequence = unwrapDer(Buffer.from(extension.value), 0x30);
  const explicit = unwrapDer(sequence, 0xa1);
  return unwrapDer(explicit, 0x04);
}

function parseAuthenticatorData(authData: Buffer) {
  if (authData.byteLength < 164) {
    throw new Error("Invalid App Attest authenticator data");
  }
  const flags = authData[32]!;
  if ((flags & 0x40) === 0) {
    throw new Error("Missing App Attest authenticator fields");
  }

  const credentialLength = authData.readUInt16BE(53);
  if (credentialLength !== 32) {
    throw new Error("Invalid App Attest credential identifier length");
  }
  const credentialStart = 55;
  const credentialEnd = credentialStart + credentialLength;
  const coseEnd = credentialEnd + 77;
  if (authData.byteLength <= coseEnd) {
    throw new Error("Invalid App Attest encoded key");
  }

  const coseKey = decode(authData.subarray(credentialEnd, coseEnd));
  const extensions = decode(authData.subarray(coseEnd));
  if (!coseKey || typeof coseKey !== "object" || !extensions || typeof extensions !== "object") {
    throw new Error("Invalid App Attest authenticator CBOR");
  }
  const extensionMap = extensions as Record<string, unknown>;
  const validationCategoryBytes = requireBuffer(
    extensionMap.apple_validation_category_01,
    "validation category",
  );
  if (validationCategoryBytes.byteLength !== 4) {
    throw new Error("Invalid App Attest validation category");
  }
  const bundleVersion = extensionMap.apple_bundle_version_01;
  if (typeof bundleVersion !== "string" || bundleVersion.length === 0) {
    throw new Error("Invalid App Attest bundle version");
  }
  const validationCategory = validationCategoryBytes.readUInt32LE();
  if (validationCategory < 1 || validationCategory > 6) {
    throw new Error("Untrusted App Attest validation category");
  }

  return {
    aaguid: authData.subarray(37, 53),
    bundleVersion,
    coseKey: coseKey as Record<string, unknown>,
    counter: authData.readUInt32BE(33),
    credentialId: authData.subarray(credentialStart, credentialEnd),
    rpIdHash: authData.subarray(0, 32),
    validationCategory,
  };
}

function publicKeyPoint(leaf: NodeX509Certificate): Buffer {
  const jwk = leaf.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Invalid App Attest public key");
  }
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
}

function expectedAaguid(environment: AppAttestEnvironment): Buffer {
  return environment === "production" ? PRODUCTION_AAGUID : DEVELOPMENT_AAGUID;
}

function decodeAssertion(value: string): {
  authenticatorData: Buffer;
  signature: Buffer;
} {
  let decoded: unknown;
  try {
    decoded = decode(Buffer.from(value, "base64"));
  } catch {
    throw new Error("Invalid App Attest assertion CBOR");
  }
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid App Attest assertion");
  }
  const assertion = decoded as Record<string, unknown>;
  return {
    authenticatorData: requireBuffer(
      assertion.authenticatorData,
      "assertion authenticator data",
    ),
    signature: requireBuffer(assertion.signature, "assertion signature"),
  };
}

function parseAssertionAuthenticatorData(
  authenticatorData: Buffer,
  fallback: { bundleVersion: string; validationCategory: number },
) {
  if (authenticatorData.byteLength < 37) {
    throw new Error("Invalid App Attest assertion authenticator data");
  }
  if (authenticatorData.byteLength === 37) {
    if (
      fallback.bundleVersion.length === 0 ||
      fallback.validationCategory < 1 ||
      fallback.validationCategory > 6
    ) {
      throw new Error("Invalid attested App Attest metadata");
    }
    return {
      bundleVersion: fallback.bundleVersion,
      counter: authenticatorData.readUInt32BE(33),
      rpIdHash: authenticatorData.subarray(0, 32),
      validationCategory: fallback.validationCategory,
    };
  }
  const extensions = decode(authenticatorData.subarray(37));
  if (!extensions || typeof extensions !== "object") {
    throw new Error("Invalid App Attest assertion extensions");
  }
  const extensionMap = extensions as Record<string, unknown>;
  const validationCategoryBytes = requireBuffer(
    extensionMap.apple_validation_category_01,
    "assertion validation category",
  );
  if (validationCategoryBytes.byteLength !== 4) {
    throw new Error("Invalid App Attest assertion validation category");
  }
  const validationCategory = validationCategoryBytes.readUInt32LE();
  if (validationCategory < 1 || validationCategory > 6) {
    throw new Error("Untrusted App Attest validation category");
  }
  const bundleVersion = extensionMap.apple_bundle_version_01;
  if (typeof bundleVersion !== "string" || bundleVersion.length === 0) {
    throw new Error("Invalid App Attest assertion bundle version");
  }
  return {
    bundleVersion,
    counter: authenticatorData.readUInt32BE(33),
    rpIdHash: authenticatorData.subarray(0, 32),
    validationCategory,
  };
}

function parseClientData(value: Uint8Array) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value).toString("utf8"));
  } catch {
    throw new Error("Invalid App Attest client data");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid App Attest client data");
  }
  const data = decoded as Record<string, unknown>;
  const keys = Object.keys(data).sort();
  if (
    keys.join(",") !== "appId,challenge,environment,keyId,requestHash" ||
    typeof data.appId !== "string" ||
    typeof data.challenge !== "string" ||
    (data.environment !== "development" && data.environment !== "production") ||
    typeof data.keyId !== "string" ||
    typeof data.requestHash !== "string" ||
    Buffer.from(data.requestHash, "base64url").byteLength !== 32
  ) {
    throw new Error("Invalid App Attest client data contract");
  }
  return data as {
    appId: string;
    challenge: string;
    environment: AppAttestEnvironment;
    keyId: string;
    requestHash: string;
  };
}

export function createAppleAppAttestVerifier(options: {
  appleRootCertificatePem?: string;
}): AppAttestCryptographicVerifier {
  return {
    async verifyAttestation(input): Promise<VerifiedAttestationEvidence> {
      const attestation = decodeAttestation(input.attestationObject);
      const leaf = verifyCertificateChain({
        intermediateDer: attestation.attStmt.x5c[1]!,
        leafDer: attestation.attStmt.x5c[0]!,
        now: input.now,
        rootPem: options.appleRootCertificatePem ?? APPLE_APP_ATTEST_ROOT_CA_PEM,
      });
      const authenticator = parseAuthenticatorData(attestation.authData);
      const nonce = sha256(
        Buffer.concat([attestation.authData, Buffer.from(input.clientDataHash)]),
      );
      if (!equal(certificateNonce(attestation.attStmt.x5c[0]!), nonce)) {
        throw new Error("Invalid App Attest challenge nonce");
      }

      const keyId = Buffer.from(input.keyId, "base64");
      const rawPublicKey = publicKeyPoint(leaf);
      if (
        keyId.byteLength !== 32 ||
        !equal(authenticator.credentialId, keyId) ||
        !equal(sha256(rawPublicKey), keyId)
      ) {
        throw new Error("Invalid App Attest key identifier");
      }
      if (!equal(authenticator.rpIdHash, sha256(Buffer.from(input.appId, "utf8")))) {
        throw new Error("Invalid App Attest relying party");
      }
      if (authenticator.counter !== 0) {
        throw new Error("Invalid App Attest attestation counter");
      }
      if (!equal(authenticator.aaguid, expectedAaguid(input.environment))) {
        throw new Error("Invalid App Attest environment");
      }

      const coseX = authenticator.coseKey["-2"];
      const coseY = authenticator.coseKey["-3"];
      if (
        !equal(requireBuffer(coseX, "COSE x coordinate"), rawPublicKey.subarray(1, 33)) ||
        !equal(requireBuffer(coseY, "COSE y coordinate"), rawPublicKey.subarray(33))
      ) {
        throw new Error("Invalid App Attest credential public key");
      }

      return {
        appId: input.appId,
        bundleVersion: authenticator.bundleVersion,
        counter: 0,
        environment: input.environment,
        keyId: input.keyId,
        publicKey: leaf.publicKey.export({ type: "spki", format: "pem" }).toString(),
        receipt: attestation.attStmt.receipt.toString("base64"),
        validationCategory: authenticator.validationCategory,
      };
    },

    async verifyAssertion(input) {
      const assertion = decodeAssertion(input.assertionObject);
      const authenticator = parseAssertionAuthenticatorData(
        assertion.authenticatorData,
        {
          bundleVersion: input.attestedBundleVersion,
          validationCategory: input.attestedValidationCategory,
        },
      );
      const clientData = parseClientData(input.clientData);
      if (
        clientData.appId !== input.appId ||
        clientData.environment !== input.environment ||
        clientData.keyId !== input.keyId ||
        clientData.challenge !== Buffer.from(input.challenge).toString("base64url")
      ) {
        throw new Error("Mismatched App Attest client data");
      }
      if (!equal(authenticator.rpIdHash, sha256(Buffer.from(input.appId, "utf8")))) {
        throw new Error("Invalid App Attest assertion relying party");
      }
      if (authenticator.counter === 0) {
        throw new Error("Invalid App Attest assertion counter");
      }

      const signedData = Buffer.concat([
        assertion.authenticatorData,
        sha256(Buffer.from(input.clientData)),
      ]);
      if (!verifySignature("sha256", signedData, input.publicKey, assertion.signature)) {
        throw new Error("Invalid App Attest assertion signature");
      }

      return {
        appId: input.appId,
        bundleVersion: authenticator.bundleVersion,
        counter: authenticator.counter,
        environment: input.environment,
        keyId: input.keyId,
        requestHash: clientData.requestHash,
        validationCategory: authenticator.validationCategory,
      };
    },
  };
}
