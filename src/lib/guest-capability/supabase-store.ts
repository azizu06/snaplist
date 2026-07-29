import "server-only";

import { z } from "zod";
import type {
  VerifiedGuestCapabilityAuthority,
  VerifiedGuestCapabilityStore,
} from "./service";

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

const authoritySchema = z.object({
  capability_id: z.string().uuid(),
  user_id: z.string().regex(/^guest_[0-9a-f]{48}$/),
}).strict();

export function createSupabaseVerifiedGuestCapabilityStore(
  client: RpcClient,
): VerifiedGuestCapabilityStore {
  return {
    async issue(input) {
      const result = await client.rpc("issue_verified_guest_capability", {
        p_activated_at: input.activatedAt.toISOString(),
        p_bearer_digest: bytea(input.bearerDigest),
        p_capability_id: input.capabilityId,
        p_expires_at: input.expiresAt.toISOString(),
        p_user_id: input.userId,
      });
      if (result.error) throw new Error("Verified guest capability issuance failed.");
      return z.boolean().parse(result.data);
    },

    async resolve(bearerDigest): Promise<VerifiedGuestCapabilityAuthority | null> {
      const result = await client.rpc("resolve_verified_guest_capability", {
        p_bearer_digest: bytea(bearerDigest),
      });
      if (result.error) throw new Error("Verified guest capability resolution failed.");
      const rows = z.array(authoritySchema).max(1).parse(result.data);
      return rows[0]
        ? { capabilityId: rows[0].capability_id, userId: rows[0].user_id }
        : null;
    },
  };
}
