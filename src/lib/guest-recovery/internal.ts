import "server-only";
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
  );

  return {
    recovery,
    claim: (input: Parameters<typeof claimGuestRecovery>[0]) =>
      claimGuestRecovery(input, { store: claims, storage }),
  };
}
