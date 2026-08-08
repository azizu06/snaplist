import "server-only";

import type {
  AppAttestChallengeRecord,
  AppAttestStore,
  AttestedKeyRecord,
  VerifiedAssertionEvidence,
  VerifiedAttestationEvidence,
} from "./service";

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

interface RpcClient {
  rpc(name: string, parameters?: Record<string, unknown>): PromiseLike<RpcResult>;
}

function bytea(value: Uint8Array): string {
  return `\\x${Buffer.from(value).toString("hex")}`;
}

function fromBytea(value: unknown): Buffer {
  if (typeof value !== "string" || !/^\\x[0-9a-f]*$/i.test(value)) {
    throw new Error("Invalid App Attest private bytea result");
  }
  return Buffer.from(value.slice(2), "hex");
}

async function call(
  client: RpcClient,
  name: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.rpc(name, parameters);
  if (result.error) throw new Error(`App Attest persistence failed: ${name}`);
  return result.data;
}

export function createSupabaseAppAttestStore(client: RpcClient): AppAttestStore {
  return {
    async issueChallenge(record) {
      await call(client, "issue_app_attest_challenge", {
        p_challenge: bytea(record.challenge),
        p_challenge_id: record.challengeId,
        p_environment: record.environment,
        p_expires_at: record.expiresAt.toISOString(),
        p_key_id: record.keyId,
        p_kind: record.kind,
      });
    },

    async claimChallenge(input) {
      const data = await call(client, "claim_app_attest_challenge", {
        p_challenge_id: input.challengeId,
        p_environment: input.environment,
        p_key_id: input.keyId,
        p_kind: input.kind,
      });
      if (data === null) return null;
      return {
        challenge: fromBytea(data),
        challengeId: input.challengeId,
        consumedAt: input.now,
        environment: input.environment,
        expiresAt: input.now,
        keyId: input.keyId,
        kind: input.kind,
      } satisfies AppAttestChallengeRecord;
    },

    async commitAttestation(input: {
      evidence: VerifiedAttestationEvidence;
      now: Date;
    }) {
      const data = await call(client, "commit_app_attest_attestation", {
        p_app_id: input.evidence.appId,
        p_bundle_version: input.evidence.bundleVersion,
        p_environment: input.evidence.environment,
        p_key_id: input.evidence.keyId,
        p_public_key_pem: input.evidence.publicKey,
        p_receipt: bytea(Buffer.from(input.evidence.receipt, "base64")),
        p_validation_category: input.evidence.validationCategory,
      });
      return data === true;
    },

    async readAttestedKey(keyId) {
      const data = await call(client, "read_app_attest_key", { p_key_id: keyId });
      const row = Array.isArray(data) ? data[0] : null;
      if (!row || typeof row !== "object") return null;
      const value = row as Record<string, unknown>;
      const hasValidOptionalMetadata =
        (value.bundle_version === null && value.validation_category === null) ||
        (typeof value.bundle_version === "string" &&
          value.bundle_version.length > 0 &&
          typeof value.validation_category === "number" &&
          value.validation_category >= 1 &&
          value.validation_category <= 6);
      if (
        typeof value.app_id !== "string" ||
        typeof value.assertion_counter !== "number" ||
        typeof value.attested_at !== "string" ||
        !hasValidOptionalMetadata ||
        (value.environment !== "development" && value.environment !== "production") ||
        typeof value.key_id !== "string" ||
        typeof value.public_key_pem !== "string"
      ) {
        throw new Error("Invalid App Attest private key result");
      }
      return {
        appId: value.app_id,
        attestedAt: new Date(value.attested_at),
        bundleVersion: value.bundle_version,
        counter: value.assertion_counter,
        environment: value.environment,
        keyId: value.key_id,
        publicKey: value.public_key_pem,
        receipt: fromBytea(value.receipt).toString("base64"),
        validationCategory: value.validation_category,
      } as AttestedKeyRecord;
    },

    async commitAssertion(input: {
      evidence: VerifiedAssertionEvidence;
      now: Date;
    }) {
      const data = await call(client, "commit_app_attest_assertion", {
        p_app_id: input.evidence.appId,
        p_assertion_counter: input.evidence.counter,
        p_bundle_version: input.evidence.bundleVersion,
        p_environment: input.evidence.environment,
        p_key_id: input.evidence.keyId,
        p_validation_category: input.evidence.validationCategory,
      });
      return data === true;
    },
  };
}
