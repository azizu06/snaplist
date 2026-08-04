import { Buffer } from "node:buffer";
import { z } from "zod";

export const MAX_GUEST_RECOVERY_PHOTOS = 5;
export const MAX_GUEST_RECOVERY_PHOTO_ENVELOPE_BYTES =
  50 * 1_024 * 1_024 + 37;

interface Base64Bounds {
  exactBytes?: number;
  minBytes?: number;
  maxBytes?: number;
}

export function canonicalGuestBase64Schema(bounds: Base64Bounds = {}) {
  return z.string().superRefine((value, context) => {
    const canonical = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    const decoded = Buffer.from(value, "base64");
    if (!canonical.test(value) || decoded.toString("base64") !== value) {
      context.addIssue({ code: "custom", message: "Expected canonical Base64." });
      return;
    }
    if (bounds.exactBytes !== undefined && decoded.byteLength !== bounds.exactBytes) {
      context.addIssue({ code: "custom", message: "Unexpected decoded byte length." });
    }
    if (bounds.minBytes !== undefined && decoded.byteLength < bounds.minBytes) {
      context.addIssue({ code: "custom", message: "Decoded value is too short." });
    }
    if (bounds.maxBytes !== undefined && decoded.byteLength > bounds.maxBytes) {
      context.addIssue({ code: "custom", message: "Decoded value is too long." });
    }
  });
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const storagePathSchema = z
  .string()
  .min(3)
  .max(1_024)
  .refine((value) => !value.includes("://") && !/[?#]/.test(value));
export const guestRecoveryEncryptionKeyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const encryptedGuestRecoveryArtifactSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("aes-256-gcm"),
    keyId: guestRecoveryEncryptionKeyIdSchema,
    keyEnvelope: canonicalGuestBase64Schema({ minBytes: 1, maxBytes: 64 * 1_024 }),
    nonce: canonicalGuestBase64Schema({ exactBytes: 12 }),
    tag: canonicalGuestBase64Schema({ exactBytes: 16 }),
    ciphertext: canonicalGuestBase64Schema({ minBytes: 1, maxBytes: 2 * 1_024 * 1_024 }),
  })
  .strict();
export const guestRecoveryObjectEncryptionSchema = z
  .object({
    algorithm: z.literal("aes-256-gcm"),
    keyId: guestRecoveryEncryptionKeyIdSchema,
    nonce: canonicalGuestBase64Schema({ exactBytes: 12 }),
    tag: canonicalGuestBase64Schema({ exactBytes: 16 }),
  })
  .strict();

export const verifiedGuestHandoffSchema = z
  .object({
    recoveryId: z.string().uuid(),
    guestUserId: z.string().min(1).max(255),
    recoveryTokenHash: sha256Schema,
  })
  .strict();

export type VerifiedGuestHandoff = z.infer<typeof verifiedGuestHandoffSchema>;

const guestClaimTerminalFields = {
    itemId: z.string().uuid(),
    runId: z.string().uuid(),
    draftId: z.string().uuid(),
    purgeLocalRecovery: z.literal(true),
};

const guestClaimExpiredOutcomeSchema = z
  .object({ outcome: z.literal("expired"), ...guestClaimTerminalFields })
  .strict();
const guestRecoveryClaimedOutcomeSchema = z
  .object({ outcome: z.literal("claimed"), ...guestClaimTerminalFields })
  .strict();

export const guestRecoveryTerminalOutcomeSchema = z.discriminatedUnion("outcome", [
  guestRecoveryClaimedOutcomeSchema,
  guestClaimExpiredOutcomeSchema,
]);

export const guestClaimObjectSchema = z
  .object({
    sourcePath: storagePathSchema,
    destinationPath: storagePathSchema,
    sha256: sha256Schema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(MAX_GUEST_RECOVERY_PHOTO_ENVELOPE_BYTES),
    encryption: guestRecoveryObjectEncryptionSchema,
  })
  .strict();

export type GuestClaimObject = z.infer<typeof guestClaimObjectSchema>;

export const guestClaimVerifiedObjectSchema = guestClaimObjectSchema
  .omit({ sourcePath: true })
  .strict();

export type GuestClaimVerifiedObject = z.infer<
  typeof guestClaimVerifiedObjectSchema
>;

export const guestClaimAccountRecoverySchema = z
  .object({
    encryptedArtifact: encryptedGuestRecoveryArtifactSchema,
    storageManifest: z
      .array(guestClaimVerifiedObjectSchema)
      .min(1)
      .max(MAX_GUEST_RECOVERY_PHOTOS),
  })
  .strict()
  .superRefine((recovery, context) => {
    if (
      new Set(recovery.storageManifest.map((object) => object.encryption.nonce)).size
        !== recovery.storageManifest.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Guest recovery AES-GCM nonces must be unique.",
        path: ["storageManifest"],
      });
    }
    recovery.storageManifest.forEach((object, index) => {
      if (object.encryption.keyId !== recovery.encryptedArtifact.keyId) {
        context.addIssue({
          code: "custom",
          message: "Storage ciphertext must use the recovery key envelope.",
          path: ["storageManifest", index, "encryption", "keyId"],
        });
      }
      if (object.encryption.nonce === recovery.encryptedArtifact.nonce) {
        context.addIssue({
          code: "custom",
          message: "Storage ciphertext cannot reuse the artifact AES-GCM nonce.",
          path: ["storageManifest", index, "encryption", "nonce"],
        });
      }
    });
  });

const guestClaimClaimedOutcomeSchema = z
  .object({
    outcome: z.literal("claimed"),
    ...guestClaimTerminalFields,
    accountRecovery: guestClaimAccountRecoverySchema,
  })
  .strict();

export const guestClaimTerminalOutcomeSchema = z.discriminatedUnion("outcome", [
  guestClaimClaimedOutcomeSchema,
  guestClaimExpiredOutcomeSchema,
]);

export type GuestClaimTerminalOutcome = z.infer<
  typeof guestClaimTerminalOutcomeSchema
>;

const guestClaimCopyPlanSchema = z
  .object({
    outcome: z.literal("copy_required"),
    claimLeaseToken: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }),
    itemId: z.string().uuid(),
    runId: z.string().uuid(),
    draftId: z.string().uuid(),
    objects: z
      .array(guestClaimObjectSchema)
      .min(1)
      .max(MAX_GUEST_RECOVERY_PHOTOS),
  })
  .strict();

const guestClaimInProgressSchema = z
  .object({
    outcome: z.literal("in_progress"),
    retryAfterSeconds: z.number().int().min(1).max(3_600),
  })
  .strict();

export const guestClaimStartSchema = z.discriminatedUnion("outcome", [
  guestClaimClaimedOutcomeSchema,
  guestClaimExpiredOutcomeSchema,
  guestClaimCopyPlanSchema,
  guestClaimInProgressSchema,
]);

export type GuestClaimStart = z.infer<typeof guestClaimStartSchema>;

export const guestRecoveryOutcomeSchema = z.discriminatedUnion("outcome", [
  guestClaimClaimedOutcomeSchema,
  guestClaimExpiredOutcomeSchema,
  z.object({ outcome: z.literal("claimable") }).strict(),
]);

export type GuestRecoveryOutcome = z.infer<typeof guestRecoveryOutcomeSchema>;

interface ClaimIdentity {
  recoveryId: string;
  recoveryTokenHash: string;
  targetUserId: string;
}

export interface GuestClaimStore {
  beginClaim(input: ClaimIdentity & {
    guestUserId: string;
    idempotencyKey: string;
    leaseSeconds: number;
  }): Promise<GuestClaimStart>;
  completeClaim(input: ClaimIdentity & {
    claimLeaseToken: string;
    verifiedObjects: GuestClaimVerifiedObject[];
  }): Promise<GuestClaimTerminalOutcome>;
  releaseClaim(input: ClaimIdentity & {
    claimLeaseToken: string;
  }): Promise<GuestRecoveryOutcome | { outcome: "released" }>;
  queueCopyCleanup(input: ClaimIdentity & {
    idempotencyKey: string;
    claimLeaseToken: string;
  }): Promise<boolean>;
  resolveOutcome(input: ClaimIdentity): Promise<GuestRecoveryOutcome>;
}

export interface GuestClaimStorage {
  copyAndVerify(object: GuestClaimObject): Promise<GuestClaimVerifiedObject>;
}

export class GuestClaimInProgressError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("The guest draft claim is already in progress.");
    this.name = "GuestClaimInProgressError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GuestClaimStorageError extends Error {
  constructor() {
    super("The guest draft could not be copied and verified. Retry before it expires.");
    this.name = "GuestClaimStorageError";
  }
}

export class GuestClaimIdempotencyConflictError extends Error {
  constructor() {
    super("The Idempotency-Key is already bound to another guest claim.");
    this.name = "GuestClaimIdempotencyConflictError";
  }
}

/**
 * The target account's one included item is already settled. Permanent: that
 * credit never returns. Raised by the advisory preflight at claim start and by
 * the authoritative check at completion (issue #504).
 */
export class GuestClaimAllowanceSpentError extends Error {
  constructor() {
    super("The account's included item credit is already spent on another run.");
    this.name = "GuestClaimAllowanceSpentError";
  }
}

/**
 * The target account has a run in flight holding its included item. Transient:
 * that reservation may still be restored, which frees the credit, so this must
 * never be presented as permanent.
 */
export class GuestClaimAllowanceInFlightError extends Error {
  constructor() {
    super("The account's included item credit is reserved by a run in flight.");
    this.name = "GuestClaimAllowanceInFlightError";
  }
}

const targetUserIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Executes only the Storage phase around the database's authoritative claim
 * predicate. The database fixes the deadline and owns the terminal outcome;
 * this orchestrator can neither extend the TTL nor transfer ownership itself.
 */
export async function claimGuestRecovery(
  rawInput: {
    handoff: VerifiedGuestHandoff;
    targetUserId: string;
    idempotencyKey: string;
  },
  dependencies: { store: GuestClaimStore; storage: GuestClaimStorage },
): Promise<GuestClaimTerminalOutcome> {
  const handoff = verifiedGuestHandoffSchema.parse(rawInput.handoff);
  const targetUserId = targetUserIdSchema.parse(rawInput.targetUserId);
  const idempotencyKey = z.string().uuid().parse(rawInput.idempotencyKey);
  const identity = {
    recoveryId: handoff.recoveryId,
    recoveryTokenHash: handoff.recoveryTokenHash,
    targetUserId,
  };
  const start = guestClaimStartSchema.parse(
    await dependencies.store.beginClaim({
      ...identity,
      guestUserId: handoff.guestUserId,
      idempotencyKey,
      leaseSeconds: 300,
    }),
  );

  if (start.outcome === "claimed" || start.outcome === "expired") {
    return start;
  }
  if (start.outcome === "in_progress") {
    throw new GuestClaimInProgressError(start.retryAfterSeconds);
  }

  const queueExactCopyCleanup = () => dependencies.store.queueCopyCleanup({
    ...identity,
    idempotencyKey,
    claimLeaseToken: start.claimLeaseToken,
  }).catch(() => false);
  const requireQuiescedExpiry = (
    outcome: GuestClaimTerminalOutcome,
    cleanupQueued: boolean,
  ) => {
    if (outcome.outcome === "expired" && !cleanupQueued) {
      throw new GuestClaimStorageError();
    }
    return outcome;
  };

  const verifiedObjects: GuestClaimVerifiedObject[] = [];
  try {
    for (const object of start.objects) {
      const verified = guestClaimVerifiedObjectSchema.parse(
        await dependencies.storage.copyAndVerify(object),
      );
      if (
        verified.destinationPath !== object.destinationPath ||
        verified.sha256 !== object.sha256 ||
        verified.byteLength !== object.byteLength
      ) {
        throw new Error("Storage verification receipt does not match the claim plan.");
      }
      verifiedObjects.push(verified);
    }
  } catch {
    const cleanupQueued = await queueExactCopyCleanup();
    const released = await dependencies.store.releaseClaim({
      ...identity,
      claimLeaseToken: start.claimLeaseToken,
    }).catch(() => null);
    if (released?.outcome === "claimed" || released?.outcome === "expired") {
      return requireQuiescedExpiry(released, cleanupQueued);
    }
    throw new GuestClaimStorageError();
  }

  let completed: GuestClaimTerminalOutcome;
  try {
    completed = guestClaimTerminalOutcomeSchema.parse(
      await dependencies.store.completeClaim({
        ...identity,
        claimLeaseToken: start.claimLeaseToken,
        verifiedObjects,
      }),
    );
  } catch (error) {
    // Requeue this exact lease first. The database protects the winning lease,
    // while an obsolete writer can recreate only its own namespace.
    const cleanupQueued = await queueExactCopyCleanup();
    const released = await dependencies.store.releaseClaim({
      ...identity,
      claimLeaseToken: start.claimLeaseToken,
    }).catch(() => null);
    if (released?.outcome === "claimed" || released?.outcome === "expired") {
      return requireQuiescedExpiry(released, cleanupQueued);
    }

    const resolved = guestRecoveryOutcomeSchema.parse(
      await dependencies.store.resolveOutcome(identity),
    );
    if (resolved.outcome === "claimed" || resolved.outcome === "expired") {
      return requireQuiescedExpiry(resolved, cleanupQueued);
    }
    // Cleanup and release come first either way. Only the reported cause
    // changes: a late allowance denial is a decided outcome, not a copy that
    // might work on retry, and calling it one would send the seller back into a
    // claim that can never complete.
    if (
      error instanceof GuestClaimAllowanceSpentError
      || error instanceof GuestClaimAllowanceInFlightError
    ) {
      throw error;
    }
    throw new GuestClaimStorageError();
  }

  if (completed.outcome === "expired") {
    return requireQuiescedExpiry(completed, await queueExactCopyCleanup());
  }
  return completed;
}
