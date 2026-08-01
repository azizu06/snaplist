import { z } from "zod";
import type { DeviceCheckAmbiguousReason } from "./device-check-adapter";

export const INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION = 1;

/** Durable state of one account/device promotion claim. */
export type IncludedOfferClaimState =
  | "queued"
  | "awaiting_device_token"
  | "apple_pending"
  | "reconcile_required"
  | "reserved"
  | "denied_device_consumed"
  | "denied_apple_unavailable";

export const INCLUDED_OFFER_TERMINAL_STATES = [
  "reserved",
  "denied_device_consumed",
  "denied_apple_unavailable",
] as const satisfies readonly IncludedOfferClaimState[];

export function isTerminalIncludedOfferState(
  state: IncludedOfferClaimState,
): boolean {
  return (INCLUDED_OFFER_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Which Apple operation a claim was performing when its outcome went ambiguous.
 *
 * This is the difference between a fence that works and one that does not. A
 * later `bit0 = true` means "someone else already consumed this device" if we
 * never observed a clear device (`query`), but means "our own write landed" if
 * we did observe clear while holding the single-writer lease (`update`).
 */
export type IncludedOfferApplePhase = "query" | "update";

export type IncludedOfferInvalidProofCode =
  | "challenge_replayed"
  | "counter_replayed"
  | "environment_mismatch"
  | "invalid_evidence"
  | "key_already_attested"
  | "key_not_attested";

export type IncludedOfferOutcome =
  /** Durably accepted and ordered behind the single-writer redemption queue. */
  | { claimId: string; retryAfterMs: number; status: "queued" }
  /** The claim reached the head; the client must supply a fresh token + proof. */
  | {
      claimId: string;
      status: "device_token_required";
      tokenDeadlineAt: string;
    }
  /** The device fence is satisfied. Only now may spend-capable work begin. */
  | { claimId: string; status: "reserved" }
  | {
      appealPath: "support-override";
      claimId: string;
      status: "denied_device_consumed";
    }
  /** The account ledger, not the device, already spent the included run. */
  | { paidPathAvailable: true; status: "denied_account_consumed" }
  | {
      appealPath: "support-override";
      claimId: string;
      paidPathAvailable: true;
      status: "denied_apple_unavailable";
    }
  | {
      claimId: string;
      paidPathAvailable: true;
      reason: DeviceCheckAmbiguousReason;
      retryAfterMs: number;
      status: "retry_required";
    }
  | { code: IncludedOfferInvalidProofCode; status: "invalid_proof" }
  | { status: "claim_not_found" };

/**
 * Wire projection of the outcome union. `satisfies` keeps it in lockstep with
 * `IncludedOfferOutcome`: adding a variant there fails this file's typecheck
 * until the wire shape covers it too.
 */
export const includedOfferOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      claimId: z.string().uuid(),
      retryAfterMs: z.number().int().nonnegative(),
      status: z.literal("queued"),
    })
    .strict(),
  z
    .object({
      claimId: z.string().uuid(),
      status: z.literal("device_token_required"),
      tokenDeadlineAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({ claimId: z.string().uuid(), status: z.literal("reserved") })
    .strict(),
  z
    .object({
      appealPath: z.literal("support-override"),
      claimId: z.string().uuid(),
      status: z.literal("denied_device_consumed"),
    })
    .strict(),
  z
    .object({
      paidPathAvailable: z.literal(true),
      status: z.literal("denied_account_consumed"),
    })
    .strict(),
  z
    .object({
      appealPath: z.literal("support-override"),
      claimId: z.string().uuid(),
      paidPathAvailable: z.literal(true),
      status: z.literal("denied_apple_unavailable"),
    })
    .strict(),
  z
    .object({
      claimId: z.string().uuid(),
      paidPathAvailable: z.literal(true),
      reason: z.enum([
        "timeout",
        "throttled",
        "server_error",
        "unavailable",
        "unauthorized",
        "malformed_response",
      ]),
      retryAfterMs: z.number().int().nonnegative(),
      status: z.literal("retry_required"),
    })
    .strict(),
  z
    .object({
      code: z.enum([
        "challenge_replayed",
        "counter_replayed",
        "environment_mismatch",
        "invalid_evidence",
        "key_already_attested",
        "key_not_attested",
      ]),
      status: z.literal("invalid_proof"),
    })
    .strict(),
  z.object({ status: z.literal("claim_not_found") }).strict(),
]) satisfies z.ZodType<IncludedOfferOutcome>;

export const appAttestProofSchema = z
  .object({
    assertionObject: z.string().min(1),
    challengeId: z.string().min(1),
    keyId: z.string().min(1),
  })
  .strict();

export type AppAttestProof = z.infer<typeof appAttestProofSchema>;

/**
 * The ephemeral DeviceCheck token, kept in its own schema so no call site can
 * accidentally fold it into a persisted structure.
 */
export const deviceCheckTokenSchema = z.string().min(1).max(8192);

export type CanonicalRedemptionRequest =
  | {
      action: "included-offer.redeem";
      idempotencyKey: string;
      userId: string;
    }
  | {
      action: "included-offer.device-token";
      claimId: string;
      userId: string;
    };

/**
 * The exact bytes an App Attest assertion signs.
 *
 * `userId` is the verified Clerk subject the server resolved, never a client
 * field: a caller who signs a different identity produces a request hash the
 * server will not reproduce. The DeviceCheck token is deliberately absent, so
 * no hash of it can ever reach a durable row, log line, or fingerprint.
 */
export function canonicalRedemptionRequest(
  input: CanonicalRedemptionRequest,
): Uint8Array {
  const payload =
    input.action === "included-offer.redeem"
      ? {
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          schemaVersion: INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION,
          userId: input.userId,
        }
      : {
          action: input.action,
          claimId: input.claimId,
          schemaVersion: INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION,
          userId: input.userId,
        };
  // Key order is fixed by construction above; both sides serialize identically.
  return new TextEncoder().encode(JSON.stringify(payload));
}
