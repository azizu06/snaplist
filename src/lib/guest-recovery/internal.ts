import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createSupabaseGuestRecoveryStore,
  type GuestRecoveryRpcClient,
} from "./recovery-store";
import { claimGuestRecovery } from "./service";
import {
  createSupabaseGuestClaimStore,
  type GuestClaimRpcClient,
} from "./store";
import {
  createSupabaseGuestClaimStorage,
  type GuestStorageClient,
} from "./storage";
import { parseGuestRecoveryDecryptionKeyringConfig } from "./decryption-keyring";

type InternalGuestClaimInput = Parameters<typeof claimGuestRecovery>[0] & {
  bearerToken: string;
};

function createTenantGuestClaimRpcClient(
  bearerToken: string,
): GuestClaimRpcClient {
  const env = getEnv();
  const apiKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey?.startsWith("sb_secret_")) {
    throw new Error(
      "A Supabase secret API key is required for tenant-bound guest claim completion.",
    );
  }
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, apiKey, {
    accessToken: async () => bearerToken,
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async rpc(functionName: string, args: Record<string, unknown>) {
      const { data, error } = await client.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
}

/**
 * Server-only #175 capabilities. Authentication and App Attest remain #174;
 * callers may pass only its already-verified handoff into `claim`.
 */
export function createInternalGuestRecoveryCapabilities() {
  const admin = createAdminClient();
  const rpcClient = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      const { data, error } = await admin.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
  const recovery = createSupabaseGuestRecoveryStore(
    rpcClient as GuestRecoveryRpcClient,
  );
  const claims = createSupabaseGuestClaimStore(
    rpcClient as GuestClaimRpcClient,
  );
  const storage = createSupabaseGuestClaimStorage(
    admin as unknown as GuestStorageClient,
    parseGuestRecoveryDecryptionKeyringConfig({
      activeEncodedKey: process.env.GUEST_RECOVERY_ENCRYPTION_KEY,
      activeKeyId: process.env.GUEST_RECOVERY_ENCRYPTION_KEY_ID,
      encodedRetiredKeys: process.env.GUEST_RECOVERY_DECRYPTION_KEYS,
    }),
  );

  return {
    recovery,
    claim: ({ bearerToken, ...input }: InternalGuestClaimInput) => {
      const tenantClaims = createSupabaseGuestClaimStore(
        createTenantGuestClaimRpcClient(bearerToken),
      );
      return claimGuestRecovery(input, {
        store: { ...claims, completeClaim: tenantClaims.completeClaim },
        storage,
      });
    },
  };
}
