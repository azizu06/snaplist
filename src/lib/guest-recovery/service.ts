import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const storagePathSchema = z
  .string()
  .min(3)
  .max(1_024)
  .refine((value) => !value.includes("://") && !/[?#]/.test(value));

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

const guestClaimClaimedOutcomeSchema = z
  .object({ outcome: z.literal("claimed"), ...guestClaimTerminalFields })
  .strict();
const guestClaimExpiredOutcomeSchema = z
  .object({ outcome: z.literal("expired"), ...guestClaimTerminalFields })
  .strict();

export const guestClaimTerminalOutcomeSchema = z.discriminatedUnion("outcome", [
  guestClaimClaimedOutcomeSchema,
  guestClaimExpiredOutcomeSchema,
]);

export type GuestClaimTerminalOutcome = z.infer<
  typeof guestClaimTerminalOutcomeSchema
>;

export const guestClaimObjectSchema = z
  .object({
    sourcePath: storagePathSchema,
    destinationPath: storagePathSchema,
    sha256: sha256Schema,
    byteLength: z.number().int().positive().max(50 * 1_024 * 1_024),
  })
  .strict();

export type GuestClaimObject = z.infer<typeof guestClaimObjectSchema>;

export const guestClaimVerifiedObjectSchema = guestClaimObjectSchema
  .omit({ sourcePath: true })
  .strict();

export type GuestClaimVerifiedObject = z.infer<
  typeof guestClaimVerifiedObjectSchema
>;

const guestClaimCopyPlanSchema = z
  .object({
    outcome: z.literal("copy_required"),
    claimLeaseToken: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }),
    itemId: z.string().uuid(),
    runId: z.string().uuid(),
    draftId: z.string().uuid(),
    objects: z.array(guestClaimObjectSchema).min(1).max(4),
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
    leaseSeconds: number;
  }): Promise<GuestClaimStart>;
  completeClaim(input: ClaimIdentity & {
    claimLeaseToken: string;
    verifiedObjects: GuestClaimVerifiedObject[];
  }): Promise<GuestClaimTerminalOutcome>;
  releaseClaim(input: ClaimIdentity & {
    claimLeaseToken: string;
  }): Promise<GuestRecoveryOutcome | { outcome: "released" }>;
  resolveOutcome(input: ClaimIdentity): Promise<GuestRecoveryOutcome>;
}

export interface GuestClaimStorage {
  copyAndVerify(object: GuestClaimObject): Promise<GuestClaimVerifiedObject>;
  remove(destinationPaths: string[]): Promise<void>;
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

const targetUserIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/);

async function removeCopiedObjects(
  storage: GuestClaimStorage,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  await storage.remove(paths).catch(() => undefined);
}

/**
 * Executes only the Storage phase around the database's authoritative claim
 * predicate. The database fixes the deadline and owns the terminal outcome;
 * this orchestrator can neither extend the TTL nor transfer ownership itself.
 */
export async function claimGuestRecovery(
  rawInput: { handoff: VerifiedGuestHandoff; targetUserId: string },
  dependencies: { store: GuestClaimStore; storage: GuestClaimStorage },
): Promise<GuestClaimTerminalOutcome> {
  const handoff = verifiedGuestHandoffSchema.parse(rawInput.handoff);
  const targetUserId = targetUserIdSchema.parse(rawInput.targetUserId);
  const identity = {
    recoveryId: handoff.recoveryId,
    recoveryTokenHash: handoff.recoveryTokenHash,
    targetUserId,
  };
  const start = guestClaimStartSchema.parse(
    await dependencies.store.beginClaim({
      ...identity,
      guestUserId: handoff.guestUserId,
      leaseSeconds: 300,
    }),
  );

  if (start.outcome === "claimed" || start.outcome === "expired") {
    return start;
  }
  if (start.outcome === "in_progress") {
    throw new GuestClaimInProgressError(start.retryAfterSeconds);
  }

  const destinationPaths = start.objects.map((object) => object.destinationPath);
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
    await dependencies.store.releaseClaim({
      ...identity,
      claimLeaseToken: start.claimLeaseToken,
    }).catch(() => undefined);
    await removeCopiedObjects(dependencies.storage, destinationPaths);
    throw new GuestClaimStorageError();
  }

  try {
    const completed = guestClaimTerminalOutcomeSchema.parse(
      await dependencies.store.completeClaim({
        ...identity,
        claimLeaseToken: start.claimLeaseToken,
        verifiedObjects,
      }),
    );
    if (completed.outcome === "expired") {
      await removeCopiedObjects(dependencies.storage, destinationPaths);
    }
    return completed;
  } catch {
    // The database commit may have succeeded even if its response was lost.
    // Resolve the terminal predicate before deleting any account object.
    const resolved = guestRecoveryOutcomeSchema.parse(
      await dependencies.store.resolveOutcome(identity),
    );
    if (resolved.outcome === "claimed") return resolved;

    if (resolved.outcome === "claimable") {
      await dependencies.store.releaseClaim({
        ...identity,
        claimLeaseToken: start.claimLeaseToken,
      }).catch(() => undefined);
    }
    await removeCopiedObjects(dependencies.storage, destinationPaths);
    if (resolved.outcome === "expired") return resolved;
    throw new GuestClaimStorageError();
  }
}
