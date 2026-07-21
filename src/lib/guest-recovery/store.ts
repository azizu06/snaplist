import { z } from "zod";
import {
  guestClaimStartSchema,
  guestClaimTerminalOutcomeSchema,
  guestClaimVerifiedObjectSchema,
  guestRecoveryOutcomeSchema,
  GuestClaimIdempotencyConflictError,
  MAX_GUEST_RECOVERY_PHOTOS,
  type GuestClaimStore,
} from "./service";

type GuestClaimRpcName =
  | "begin_guest_draft_claim"
  | "complete_guest_draft_claim"
  | "queue_guest_claim_copy_cleanup"
  | "release_guest_draft_claim"
  | "resolve_guest_recovery_outcome";

interface GuestClaimRpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface GuestClaimRpcClient {
  rpc(
    functionName: GuestClaimRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<GuestClaimRpcResult>;
}

function rpcData(operation: string, result: GuestClaimRpcResult): unknown {
  if (result.error) {
    if (result.error.message === "Guest claim Idempotency-Key is already bound") {
      throw new GuestClaimIdempotencyConflictError();
    }
    throw new Error(`Guest recovery ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

const releaseOutcomeSchema = z.discriminatedUnion("outcome", [
  ...guestClaimTerminalOutcomeSchema.options,
  z.object({ outcome: z.literal("claimable") }).strict(),
  z.object({ outcome: z.literal("released") }).strict(),
]);

/** Fixed service-role RPC capability; it provides no generic table access. */
export function createSupabaseGuestClaimStore(
  client: GuestClaimRpcClient,
): GuestClaimStore {
  return {
    async beginClaim(input) {
      const result = await client.rpc("begin_guest_draft_claim", {
        p_claim_lease_seconds: z.number().int().min(30).max(3_600).parse(input.leaseSeconds),
        p_guest_user_id: z.string().min(1).max(255).parse(input.guestUserId),
        p_idempotency_key: z.string().uuid().parse(input.idempotencyKey),
        p_recovery_id: z.string().uuid().parse(input.recoveryId),
        p_recovery_token_hash: z.string().regex(/^[0-9a-f]{64}$/).parse(input.recoveryTokenHash),
        p_target_user_id: z.string().min(1).max(255).parse(input.targetUserId),
      });
      return guestClaimStartSchema.parse(rpcData("claim start", result));
    },

    async completeClaim(input) {
      const result = await client.rpc("complete_guest_draft_claim", {
        p_claim_lease_token: z.string().uuid().parse(input.claimLeaseToken),
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
