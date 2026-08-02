import "server-only";

import {
  createHash,
  createHmac,
  randomBytes as secureRandomBytes,
  randomUUID as secureRandomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type {
  AppAttestEnvironment,
  AppAttestVerificationResult,
  createAppAttestService,
} from "./service";
import {
  verifiedGuestHandoffSchema,
  type VerifiedGuestHandoff,
} from "@/lib/guest-recovery/service";

const photoIdentitySchema = z
  .object({
    kind: z.literal("content_sha256_set_v1"),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const handoffClientDataSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("guest-claim-handoff"),
    recoveryId: z.string().uuid(),
    recoveryToken: z.string().min(32).max(512).regex(/^[A-Za-z0-9._~-]+$/),
    photoIdentity: photoIdentitySchema,
  })
  .strict();

export type GuestHandoffClientData = z.infer<typeof handoffClientDataSchema>;

type VerifiedAppAttestAssertion = Extract<
  AppAttestVerificationResult,
  { kind: "assertion"; status: "verified" }
>;

export interface GuestClaimHandoffRecord {
  appId: string;
  environment: AppAttestEnvironment;
  expiresAt: Date;
  guestUserId: string;
  handoffId: string;
  issuedAt: Date;
  keyId: string;
  photoSetFingerprint: string;
  recoveryId: string;
  recoveryTokenHash: string;
  tokenDigest: Uint8Array;
}

export interface GuestClaimHandoffStore {
  issue(record: GuestClaimHandoffRecord): Promise<boolean>;
  consume(input: {
    appId: string;
    environment: AppAttestEnvironment;
    handoffId: string;
    now: Date;
    tokenDigest: Uint8Array;
  }): Promise<VerifiedGuestHandoff | null>;
}

interface AttestedKeyFixture {
  appId: string;
  environment: AppAttestEnvironment;
  keyId: string;
}

interface RecoveryFixture {
  guestUserId: string;
  photoSetFingerprint: string;
  recoveryId: string;
  recoveryTokenHash: string;
}

/** Contract-test store. Production uses the atomic Postgres implementation. */
export class InMemoryGuestClaimHandoffStore implements GuestClaimHandoffStore {
  readonly #keys = new Map<string, AttestedKeyFixture>();
  readonly #recoveries = new Map<string, RecoveryFixture>();
  readonly #handoffs = new Map<string, GuestClaimHandoffRecord>();

  constructor(fixtures: {
    attestedKeys?: AttestedKeyFixture[];
    recoveries?: RecoveryFixture[];
  } = {}) {
    for (const key of fixtures.attestedKeys ?? []) {
      this.#keys.set(key.keyId, structuredClone(key));
    }
    for (const recovery of fixtures.recoveries ?? []) {
      this.#recoveries.set(recovery.recoveryId, structuredClone(recovery));
    }
  }

  setRecoveryPhotoSetFingerprint(
    recoveryId: string,
    photoSetFingerprint: string,
  ): void {
    const recovery = this.#recoveries.get(recoveryId);
    if (!recovery) throw new Error("Unknown guest recovery fixture.");
    recovery.photoSetFingerprint = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(photoSetFingerprint);
  }

  async issue(record: GuestClaimHandoffRecord): Promise<boolean> {
    const key = this.#keys.get(record.keyId);
    const recovery = this.#recoveries.get(record.recoveryId);
    if (
      !key ||
      key.appId !== record.appId ||
      key.environment !== record.environment ||
      !recovery ||
      recovery.guestUserId !== record.guestUserId ||
      recovery.recoveryTokenHash !== record.recoveryTokenHash ||
      recovery.photoSetFingerprint !== record.photoSetFingerprint ||
      this.#handoffs.has(record.handoffId)
    ) {
      return false;
    }
    this.#handoffs.set(record.handoffId, structuredClone(record));
    return true;
  }

  async consume(input: {
    appId: string;
    environment: AppAttestEnvironment;
    handoffId: string;
    now: Date;
    tokenDigest: Uint8Array;
  }): Promise<VerifiedGuestHandoff | null> {
    const handoff = this.#handoffs.get(input.handoffId);
    if (!handoff) return null;
    const key = this.#keys.get(handoff.keyId);
    const recovery = this.#recoveries.get(handoff.recoveryId);
    if (
      handoff.appId !== input.appId ||
      handoff.environment !== input.environment ||
      handoff.expiresAt.getTime() <= input.now.getTime() ||
      !equalBytes(handoff.tokenDigest, input.tokenDigest) ||
      !key ||
      key.appId !== handoff.appId ||
      key.environment !== handoff.environment ||
      !recovery ||
      recovery.guestUserId !== handoff.guestUserId ||
      recovery.recoveryTokenHash !== handoff.recoveryTokenHash ||
      recovery.photoSetFingerprint !== handoff.photoSetFingerprint
    ) {
      return null;
    }
    this.#handoffs.delete(input.handoffId);
    return verifiedGuestHandoffSchema.parse({
      guestUserId: handoff.guestUserId,
      recoveryId: handoff.recoveryId,
      recoveryTokenHash: handoff.recoveryTokenHash,
    });
  }
}

export class InvalidGuestClaimHandoffError extends Error {
  constructor() {
    super("The guest claim handoff is invalid or no longer active.");
    this.name = "InvalidGuestClaimHandoffError";
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function derivedGuestUserId(appId: string, keyId: string): string {
  return `guest_${createHash("sha256")
    .update(appId)
    .update("\0")
    .update(keyId)
    .digest("hex")
    .slice(0, 48)}`;
}

export function createGuestClaimHandoffService(options: {
  appId: string;
  clock?: () => Date;
  environment: AppAttestEnvironment;
  handoffId?: () => string;
  randomBytes?: (size: number) => Uint8Array;
  signingKey: Uint8Array;
  store: GuestClaimHandoffStore;
  ttlMs: number;
}) {
  const signingKey = Buffer.from(options.signingKey);
  if (signingKey.byteLength < 32) {
    throw new Error("Guest claim handoff signing key requires at least 32 bytes.");
  }
  if (!Number.isInteger(options.ttlMs) || options.ttlMs < 60_000 || options.ttlMs > 600_000) {
    throw new Error("Guest claim handoff TTL must be between 60 and 600 seconds.");
  }
  const clock = options.clock ?? (() => new Date());
  const makeHandoffId = options.handoffId ?? secureRandomUUID;
  const makeRandomBytes = options.randomBytes ?? secureRandomBytes;

  function signature(unsigned: string): Buffer {
    return createHmac("sha256", signingKey).update(unsigned).digest();
  }

  return {
    async issue(
      assertion: VerifiedAppAttestAssertion,
      clientData: GuestHandoffClientData,
    ) {
      if (
        assertion.appId !== options.appId ||
        assertion.environment !== options.environment
      ) {
        throw new InvalidGuestClaimHandoffError();
      }
      const issuedAt = clock();
      const expiresAt = new Date(issuedAt.getTime() + options.ttlMs);
      const handoffId = makeHandoffId();
      const encodedId = Buffer.from(handoffId, "utf8").toString("base64url");
      const nonce = Buffer.from(makeRandomBytes(32)).toString("base64url");
      const unsigned = `guesthandoff_v1.${encodedId}.${nonce}`;
      const handoffToken = `${unsigned}.${signature(unsigned).toString("base64url")}`;
      const record: GuestClaimHandoffRecord = {
        appId: options.appId,
        environment: options.environment,
        expiresAt,
        guestUserId: derivedGuestUserId(options.appId, assertion.keyId),
        handoffId,
        issuedAt,
        keyId: assertion.keyId,
        photoSetFingerprint: clientData.photoIdentity.fingerprint,
        recoveryId: clientData.recoveryId,
        recoveryTokenHash: digest(clientData.recoveryToken).toString("hex"),
        tokenDigest: digest(handoffToken),
      };
      if (!(await options.store.issue(record))) {
        throw new InvalidGuestClaimHandoffError();
      }
      return {
        expiresAt: expiresAt.toISOString(),
        handoffToken,
        photoIdentity: clientData.photoIdentity,
        recoveryId: clientData.recoveryId,
      };
    },

    verify: async (handoffToken: string): Promise<VerifiedGuestHandoff> => {
      const match = handoffToken.match(
        /^guesthandoff_v1\.([A-Za-z0-9_-]{48})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/,
      );
      if (!match) throw new InvalidGuestClaimHandoffError();
      const [, encodedId, nonce, encodedSignature] = match;
      const handoffId = Buffer.from(encodedId!, "base64url").toString("utf8");
      if (!z.string().uuid().safeParse(handoffId).success) {
        throw new InvalidGuestClaimHandoffError();
      }
      const unsigned = `guesthandoff_v1.${encodedId}.${nonce}`;
      const suppliedSignature = Buffer.from(encodedSignature!, "base64url");
      if (!equalBytes(signature(unsigned), suppliedSignature)) {
        throw new InvalidGuestClaimHandoffError();
      }
      const verified = await options.store.consume({
        appId: options.appId,
        environment: options.environment,
        handoffId,
        now: clock(),
        tokenDigest: digest(handoffToken),
      });
      if (!verified) throw new InvalidGuestClaimHandoffError();
      return verified;
    },
  };
}

type AppAttestService = Pick<
  ReturnType<typeof createAppAttestService>,
  "issueChallenge" | "verifyAttestation" | "verifyAssertion"
>;

const canonicalBase64Schema = z.string().max(1_400_000).refine((value) => {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
});

const handoffRequestSchema = z
  .object({
    assertionObject: canonicalBase64Schema.max(128_000),
    challengeId: z.string().uuid(),
    clientData: canonicalBase64Schema,
    keyId: canonicalBase64Schema.max(512),
    operation: z.literal("handoff"),
  })
  .strict();

function apiError(
  requestId: string,
  status: number,
  code: "forbidden" | "invalid_request" | "internal_error" | "unauthorized",
  message: string,
): Response {
  return Response.json({ error: { code, message, requestId } }, { status });
}

export function createGuestAttestationHandler(options: {
  appAttest: AppAttestService;
  handoffs: ReturnType<typeof createGuestClaimHandoffService>;
  requestId?: () => string;
}) {
  const nextRequestId = options.requestId ?? (() => globalThis.crypto.randomUUID());
  return async (request: Request): Promise<Response> => {
    const requestId = nextRequestId();
    if (request.method !== "POST") {
      return apiError(requestId, 405, "invalid_request", "This method is not allowed.");
    }
    const rawBody = await request.text().catch(() => "");
    if (rawBody.length === 0 || rawBody.length > 1_600_000) {
      return apiError(requestId, 400, "invalid_request", "The request is invalid.");
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return apiError(requestId, 400, "invalid_request", "The request is invalid.");
    }
    const parsed = handoffRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(requestId, 400, "invalid_request", "The request is invalid.");
    }
    const clientDataBytes = Buffer.from(parsed.data.clientData, "base64");
    let clientData: GuestHandoffClientData;
    try {
      clientData = handoffClientDataSchema.parse(
        JSON.parse(clientDataBytes.toString("utf8")),
      );
    } catch {
      return apiError(requestId, 400, "invalid_request", "The request is invalid.");
    }

    try {
      const assertion = await options.appAttest.verifyAssertion({
        assertionObject: parsed.data.assertionObject,
        challengeId: parsed.data.challengeId,
        keyId: parsed.data.keyId,
        requestBody: clientDataBytes,
      });
      if (assertion.status !== "verified" || assertion.kind !== "assertion") {
        const unattested = "code" in assertion && assertion.code === "key_not_attested";
        return apiError(
          requestId,
          unattested ? 403 : 401,
          unattested ? "forbidden" : "unauthorized",
          unattested
            ? "App Attest is required for the guest allowance."
            : "The App Attest assertion is invalid or no longer active.",
        );
      }
      const handoff = await options.handoffs.issue(assertion, clientData);
      return Response.json(
        { data: handoff, meta: { requestId } },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof InvalidGuestClaimHandoffError) {
        return apiError(
          requestId,
          401,
          "unauthorized",
          "The guest recovery proof does not match the attested photo set.",
        );
      }
      return apiError(
        requestId,
        503,
        "internal_error",
        "Guest attestation is temporarily unavailable.",
      );
    }
  };
}
