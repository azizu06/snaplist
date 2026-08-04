import { z } from "zod";
import {
  guestClaimStartSchema,
  guestClaimTerminalOutcomeSchema,
  guestClaimVerifiedObjectSchema,
  guestRecoveryOutcomeSchema,
  GuestClaimAllowanceInFlightError,
  GuestClaimAllowanceSpentError,
  GuestClaimIdempotencyConflictError,
  MAX_GUEST_RECOVERY_PHOTOS,
  type GuestClaimStore,
} from "./service";

type GuestClaimRpcName =
  | "begin_guest_draft_claim_with_plaintext"
  | "complete_guest_draft_claim_with_plaintext"
  | "queue_guest_claim_copy_cleanup"
  | "release_guest_draft_claim"
  | "resolve_guest_recovery_outcome";

interface GuestClaimRpcResult {
  data: unknown;
  /** PostgREST surfaces the raise message and its SQLSTATE as `code`. */
  error: { message: string; code?: string } | null;
}

export interface GuestClaimRpcClient {
  rpc(
    functionName: GuestClaimRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<GuestClaimRpcResult>;
}

// This seam is the only place a caller learns which denial it hit, so it keys on
// the most stable signal available. `SL001` and `SL002` exist for exactly this
// dispatch and nothing else raises them (issue #504). A generic SQLSTATE is not
// safe to key on: `23505` is raised by the idempotency bind and by any real
// unique constraint alike, so that one stays on its message.
const guestClaimErrorsByCode = new Map<string, () => Error>([
  ["SL001", () => new GuestClaimAllowanceSpentError()],
  ["SL002", () => new GuestClaimAllowanceInFlightError()],
]);

const guestClaimErrorsByMessage = new Map<string, () => Error>([
  [
    "Guest claim Idempotency-Key is already bound",
    () => new GuestClaimIdempotencyConflictError(),
  ],
  [
    "Account included credit is already spent on another run",
    () => new GuestClaimAllowanceSpentError(),
  ],
  [
    "Account included credit is reserved by a run in flight",
    () => new GuestClaimAllowanceInFlightError(),
  ],
]);

function rpcData(operation: string, result: GuestClaimRpcResult): unknown {
  if (result.error) {
    const known = (result.error.code
      ? guestClaimErrorsByCode.get(result.error.code)
      : undefined)
      ?? guestClaimErrorsByMessage.get(result.error.message);
    if (known) throw known();
    throw new Error(`Guest recovery ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

const releaseOutcomeSchema = z.discriminatedUnion("outcome", [
  ...guestClaimTerminalOutcomeSchema.options,
  z.object({ outcome: z.literal("claimable") }).strict(),
  z.object({ outcome: z.literal("released") }).strict(),
]);

/** Fixed RPC capabilities; plaintext completion is tenant- and lease-capability-paired. */
export function createSupabaseGuestClaimStore(
  client: GuestClaimRpcClient,
): GuestClaimStore {
  return {
    async beginClaim(input) {
      const result = await client.rpc("begin_guest_draft_claim_with_plaintext", {
        p_claim_lease_seconds: z.number().int().min(30).max(3_600).parse(input.leaseSeconds),
        p_completion_token_hash: z.string().regex(/^[0-9a-f]{64}$/).parse(input.completionTokenHash),
        p_guest_user_id: z.string().min(1).max(255).parse(input.guestUserId),
        p_idempotency_key: z.string().uuid().parse(input.idempotencyKey),
        p_recovery_id: z.string().uuid().parse(input.recoveryId),
        p_recovery_token_hash: z.string().regex(/^[0-9a-f]{64}$/).parse(input.recoveryTokenHash),
        p_target_user_id: z.string().min(1).max(255).parse(input.targetUserId),
      });
      return guestClaimStartSchema.parse(rpcData("claim start", result));
    },

    async completeClaim(input) {
      const result = await client.rpc("complete_guest_draft_claim_with_plaintext", {
        p_claim_lease_token: z.string().uuid().parse(input.claimLeaseToken),
        p_completion_token: z.string().regex(/^[0-9a-f]{64}$/).parse(input.completionToken),
        p_recovery_id: z.string().uuid().parse(input.recoveryId),
        p_recovery_token_hash: z.string().regex(/^[0-9a-f]{64}$/).parse(input.recoveryTokenHash),
        p_target_user_id: z.string().min(1).max(255).parse(input.targetUserId),
        p_verified_objects: z
          .array(guestClaimVerifiedObjectSchema)
          .min(1)
          .max(MAX_GUEST_RECOVERY_PHOTOS)
          .parse(input.verifiedObjects),
      });
      return guestClaimTerminalOutcomeSchema.parse(
        rpcData("claim completion", result),
      );
    },

    async releaseClaim(input) {
      const result = await client.rpc("release_guest_draft_claim", {
        p_claim_lease_token: z.string().uuid().parse(input.claimLeaseToken),
        p_recovery_id: z.string().uuid().parse(input.recoveryId),
        p_recovery_token_hash: z.string().regex(/^[0-9a-f]{64}$/).parse(input.recoveryTokenHash),
        p_target_user_id: z.string().min(1).max(255).parse(input.targetUserId),
      });
      return releaseOutcomeSchema.parse(rpcData("claim release", result));
    },

    async queueCopyCleanup(input) {
      const result = await client.rpc("queue_guest_claim_copy_cleanup", {
        p_claim_lease_token: z.string().uuid().parse(input.claimLeaseToken),
        p_idempotency_key: z.string().uuid().parse(input.idempotencyKey),
        p_recovery_id: z.string().uuid().parse(input.recoveryId),
        p_recovery_token_hash: z.string().regex(/^[0-9a-f]{64}$/).parse(input.recoveryTokenHash),
        p_target_user_id: z.string().min(1).max(255).parse(input.targetUserId),
      });
      return z.boolean().parse(rpcData("claim copy cleanup", result));
    },

    async resolveOutcome(input) {
      const result = await client.rpc("resolve_guest_recovery_outcome", {
        p_recovery_id: z.string().uuid().parse(input.recoveryId),
        p_recovery_token_hash: z.string().regex(/^[0-9a-f]{64}$/).parse(input.recoveryTokenHash),
        p_target_user_id: z.string().min(1).max(255).parse(input.targetUserId),
      });
      return guestRecoveryOutcomeSchema.parse(
        rpcData("outcome resolution", result),
      );
    },
  };
}
