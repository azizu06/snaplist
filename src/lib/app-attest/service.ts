import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

export type AppAttestEnvironment = "development" | "production";
export type AppAttestChallengeKind = "attestation" | "assertion";

export interface IssuedAppAttestChallenge {
  challenge: string;
  challengeId: string;
  expiresAt: string;
  kind: AppAttestChallengeKind;
}

export interface VerifiedAttestationEvidence {
  appId: string;
  bundleVersion: string | null;
  counter: 0;
  environment: AppAttestEnvironment;
  keyId: string;
  publicKey: string;
  receipt: string;
  validationCategory: number | null;
}

export interface VerifiedAssertionEvidence {
  appId: string;
  bundleVersion: string | null;
  counter: number;
  environment: AppAttestEnvironment;
  keyId: string;
  requestHash: string;
  validationCategory: number | null;
}

export interface AppAttestCryptographicVerifier {
  verifyAttestation(input: {
    appId: string;
    attestationObject: string;
    clientDataHash: Uint8Array;
    environment: AppAttestEnvironment;
    keyId: string;
    now: Date;
  }): Promise<VerifiedAttestationEvidence>;
  verifyAssertion(input: {
    appId: string;
    assertionObject: string;
    attestedBundleVersion: string | null;
    attestedValidationCategory: number | null;
    challenge: Uint8Array;
    clientData: Uint8Array;
    environment: AppAttestEnvironment;
    keyId: string;
    now: Date;
    publicKey: string;
  }): Promise<VerifiedAssertionEvidence>;
}

export interface AppAttestChallengeRecord {
  challenge: Uint8Array;
  challengeId: string;
  consumedAt: Date | null;
  environment: AppAttestEnvironment;
  expiresAt: Date;
  keyId: string | null;
  kind: AppAttestChallengeKind;
}

export interface AttestedKeyRecord
  extends Omit<VerifiedAttestationEvidence, "counter"> {
  attestedAt: Date;
  counter: number;
}

export interface AppAttestStore {
  issueChallenge(record: AppAttestChallengeRecord): Promise<void>;
  claimChallenge(input: {
    challengeId: string;
    keyId: string | null;
    kind: AppAttestChallengeKind;
    now: Date;
    environment: AppAttestEnvironment;
  }): Promise<AppAttestChallengeRecord | null>;
  commitAttestation(input: {
    evidence: VerifiedAttestationEvidence;
    now: Date;
  }): Promise<boolean>;
  commitAssertion(input: {
    evidence: VerifiedAssertionEvidence;
    now: Date;
  }): Promise<boolean>;
  readAttestedKey(keyId: string): Promise<AttestedKeyRecord | null>;
}

export class InMemoryAppAttestStore implements AppAttestStore {
  readonly #challenges = new Map<string, AppAttestChallengeRecord>();
  readonly #keys = new Map<string, AttestedKeyRecord>();

  async issueChallenge(record: AppAttestChallengeRecord): Promise<void> {
    if (this.#challenges.has(record.challengeId)) {
      throw new Error("Duplicate App Attest challenge identifier");
    }
    this.#challenges.set(record.challengeId, structuredClone(record));
  }

  async claimChallenge(input: {
    challengeId: string;
    keyId: string | null;
    kind: AppAttestChallengeKind;
    now: Date;
    environment: AppAttestEnvironment;
  }): Promise<AppAttestChallengeRecord | null> {
    const record = this.#challenges.get(input.challengeId);
    if (
      !record ||
      record.consumedAt ||
      record.expiresAt.getTime() <= input.now.getTime() ||
      record.environment !== input.environment ||
      record.kind !== input.kind ||
      record.keyId !== input.keyId
    ) {
      return null;
    }

    record.consumedAt = input.now;
    return structuredClone(record);
  }

  async commitAttestation(input: {
    evidence: VerifiedAttestationEvidence;
    now: Date;
  }): Promise<boolean> {
    if (this.#keys.has(input.evidence.keyId)) return false;
    this.#keys.set(input.evidence.keyId, {
      ...structuredClone(input.evidence),
      attestedAt: input.now,
    });
    return true;
  }

  async readAttestedKey(keyId: string): Promise<AttestedKeyRecord | null> {
    const key = this.#keys.get(keyId);
    return key ? structuredClone(key) : null;
  }

  async commitAssertion(input: {
    evidence: VerifiedAssertionEvidence;
    now: Date;
  }): Promise<boolean> {
    const key = this.#keys.get(input.evidence.keyId);
    if (
      !key ||
      key.appId !== input.evidence.appId ||
      key.environment !== input.evidence.environment ||
      input.evidence.counter <= key.counter
    ) {
      return false;
    }
    key.bundleVersion = input.evidence.bundleVersion;
    key.counter = input.evidence.counter;
    key.validationCategory = input.evidence.validationCategory;
    return true;
  }

  snapshot(): unknown {
    return structuredClone({
      challenges: [...this.#challenges.entries()],
      keys: [...this.#keys.entries()],
    });
  }
}

export type AppAttestVerificationResult =
  | ({
      kind: "attestation";
      status: "verified";
    } & Pick<
      VerifiedAttestationEvidence,
      | "appId"
      | "bundleVersion"
      | "counter"
      | "environment"
      | "keyId"
      | "validationCategory"
    >)
  | ({
      kind: "assertion";
      status: "verified";
    } & Pick<
      VerifiedAssertionEvidence,
      | "appId"
      | "bundleVersion"
      | "counter"
      | "environment"
      | "keyId"
      | "requestHash"
      | "validationCategory"
    >)
  | {
      code:
        | "challenge_replayed"
        | "environment_mismatch"
        | "invalid_evidence"
        | "key_already_attested"
        | "key_not_attested"
        | "counter_replayed";
      kind: AppAttestChallengeKind;
      status: "invalid";
    };

export function createAppAttestService(options: {
  appId: string;
  challengeBytes?: () => Uint8Array;
  challengeId?: () => string;
  challengeTtlMs: number;
  clock?: () => Date;
  environment: AppAttestEnvironment;
  reportVerificationError?: (
    phase: "assertion" | "attestation",
    error: unknown,
  ) => void;
  store: AppAttestStore;
  verifier: AppAttestCryptographicVerifier;
}) {
  const appId = options.appId;
  const clock = options.clock ?? (() => new Date());
  const makeChallenge = options.challengeBytes ?? (() => randomBytes(32));
  const makeChallengeId = options.challengeId ?? randomUUID;

  function clientData(input: {
    challenge: Uint8Array;
    keyId: string;
    requestHash: string;
  }): Buffer {
    return Buffer.from(
      JSON.stringify({
        appId,
        challenge: Buffer.from(input.challenge).toString("base64url"),
        environment: options.environment,
        keyId: input.keyId,
        requestHash: input.requestHash,
      }),
      "utf8",
    );
  }

  return {
    async issueChallenge(input: {
      keyId?: string;
      kind: AppAttestChallengeKind;
    }): Promise<IssuedAppAttestChallenge> {
      const now = clock();
      const challenge = makeChallenge();
      if (challenge.byteLength < 16) {
        throw new Error("App Attest challenges require at least 16 bytes of entropy");
      }
      const record: AppAttestChallengeRecord = {
        challenge,
        challengeId: makeChallengeId(),
        consumedAt: null,
        environment: options.environment,
        expiresAt: new Date(now.getTime() + options.challengeTtlMs),
        keyId: input.keyId ?? null,
        kind: input.kind,
      };
      await options.store.issueChallenge(record);
      return {
        challenge: Buffer.from(challenge).toString("base64url"),
        challengeId: record.challengeId,
        expiresAt: record.expiresAt.toISOString(),
        kind: record.kind,
      };
    },

    async verifyAttestation(input: {
      attestationObject: string;
      challengeId: string;
      keyId: string;
    }): Promise<AppAttestVerificationResult> {
      const now = clock();
      const challenge = await options.store.claimChallenge({
        challengeId: input.challengeId,
        keyId: null,
        kind: "attestation",
        now,
        environment: options.environment,
      });
      if (!challenge) {
        return {
          code: "challenge_replayed",
          kind: "attestation",
          status: "invalid",
        };
      }

      let evidence: VerifiedAttestationEvidence;
      try {
        evidence = await options.verifier.verifyAttestation({
          appId,
          attestationObject: input.attestationObject,
          clientDataHash: createHash("sha256")
            .update(challenge.challenge)
            .digest(),
          environment: options.environment,
          keyId: input.keyId,
          now,
        });
      } catch (error) {
        options.reportVerificationError?.("attestation", error);
        return {
          code: "invalid_evidence",
          kind: "attestation",
          status: "invalid",
        };
      }

      if (
        evidence.environment !== options.environment ||
        evidence.appId !== appId
      ) {
        return {
          code: "environment_mismatch",
          kind: "attestation",
          status: "invalid",
        };
      }
      if (evidence.keyId !== input.keyId) {
        return {
          code: "invalid_evidence",
          kind: "attestation",
          status: "invalid",
        };
      }
      if (!(await options.store.commitAttestation({ evidence, now }))) {
        return {
          code: "key_already_attested",
          kind: "attestation",
          status: "invalid",
        };
      }

      return {
        appId: evidence.appId,
        bundleVersion: evidence.bundleVersion,
        counter: evidence.counter,
        environment: evidence.environment,
        keyId: evidence.keyId,
        kind: "attestation",
        status: "verified",
        validationCategory: evidence.validationCategory,
      };
    },

    async verifyAssertion(input: {
      assertionObject: string;
      challengeId: string;
      clientData?: Uint8Array;
      keyId: string;
      requestBody: Uint8Array;
    }): Promise<AppAttestVerificationResult> {
      const now = clock();
      const key = await options.store.readAttestedKey(input.keyId);
      if (!key) {
        return {
          code: "key_not_attested",
          kind: "assertion",
          status: "invalid",
        };
      }
      if (key.appId !== appId || key.environment !== options.environment) {
        return {
          code: "environment_mismatch",
          kind: "assertion",
          status: "invalid",
        };
      }

      const challenge = await options.store.claimChallenge({
        challengeId: input.challengeId,
        keyId: input.keyId,
        kind: "assertion",
        now,
        environment: options.environment,
      });
      if (!challenge) {
        return {
          code: "challenge_replayed",
          kind: "assertion",
          status: "invalid",
        };
      }

      const requestHash = createHash("sha256")
        .update(input.requestBody)
        .digest("base64url");
      let evidence: VerifiedAssertionEvidence;
      try {
        evidence = await options.verifier.verifyAssertion({
          appId,
          assertionObject: input.assertionObject,
          attestedBundleVersion: key.bundleVersion,
          attestedValidationCategory: key.validationCategory,
          challenge: challenge.challenge,
          clientData:
            input.clientData ??
            clientData({
              challenge: challenge.challenge,
              keyId: input.keyId,
              requestHash,
            }),
          environment: options.environment,
          keyId: input.keyId,
          now,
          publicKey: key.publicKey,
        });
      } catch (error) {
        options.reportVerificationError?.("assertion", error);
        return {
          code: "invalid_evidence",
          kind: "assertion",
          status: "invalid",
        };
      }
      if (
        evidence.appId !== appId ||
        evidence.environment !== options.environment ||
        evidence.keyId !== input.keyId ||
        evidence.requestHash !== requestHash
      ) {
        return {
          code: "invalid_evidence",
          kind: "assertion",
          status: "invalid",
        };
      }
      if (!(await options.store.commitAssertion({ evidence, now }))) {
        return {
          code: "counter_replayed",
          kind: "assertion",
          status: "invalid",
        };
      }
      return {
        appId: evidence.appId,
        bundleVersion: evidence.bundleVersion,
        counter: evidence.counter,
        environment: evidence.environment,
        keyId: evidence.keyId,
        kind: "assertion",
        requestHash: evidence.requestHash,
        status: "verified",
        validationCategory: evidence.validationCategory,
      };
    },
  };
}
