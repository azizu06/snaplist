import "server-only";

import { z } from "zod";
import type {
  GuestClaimHandoffRecord,
  GuestClaimHandoffStore,
} from "./guest-handoff";

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

interface RpcClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<RpcResult>;
}

function bytea(value: Uint8Array): string {
  return `\\x${Buffer.from(value).toString("hex")}`;
}

function rpcData(operation: string, result: RpcResult): unknown {
  if (result.error) {
    throw new Error(`Guest claim handoff ${operation} failed.`);
  }
  return result.data;
}

const consumedHandoffSchema = z
  .object({
    guest_user_id: z.string().regex(/^guest_[0-9a-f]{48}$/),
    recovery_id: z.string().uuid(),
    recovery_token_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Fixed service-role RPC capability. It has no generic table or tenant access. */
export function createSupabaseGuestClaimHandoffStore(
  client: RpcClient,
): GuestClaimHandoffStore {
  return {
    async issue(record: GuestClaimHandoffRecord): Promise<boolean> {
      const result = await client.rpc("issue_guest_claim_handoff", {
        p_app_id: record.appId,
        p_environment: record.environment,
        p_expires_at: record.expiresAt.toISOString(),
        p_guest_user_id: record.guestUserId,
        p_handoff_id: record.handoffId,
        p_issued_at: record.issuedAt.toISOString(),
        p_key_id: record.keyId,
        p_photo_set_fingerprint: record.photoSetFingerprint,
        p_recovery_id: record.recoveryId,
        p_recovery_token_hash: record.recoveryTokenHash,
        p_token_digest: bytea(record.tokenDigest),
      });
      return z.boolean().parse(rpcData("issuance", result));
    },

    async consume(input) {
      // Expiry uses statement_timestamp() inside the atomic RPC. The process
      // clock is deliberately not trusted by production persistence.
      const result = await client.rpc("consume_guest_claim_handoff", {
        p_app_id: input.appId,
        p_environment: input.environment,
        p_handoff_id: input.handoffId,
        p_token_digest: bytea(input.tokenDigest),
      });
      const rows = z.array(consumedHandoffSchema).max(1).parse(
        rpcData("verification", result),
      );
      const row = rows[0];
      return row
        ? {
            guestUserId: row.guest_user_id,
            recoveryId: row.recovery_id,
            recoveryTokenHash: row.recovery_token_hash,
          }
        : null;
    },
  };
}
