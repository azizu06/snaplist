import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createSupabasePipelineStagingStore,
  type PipelineStagingRpcClient,
  type PipelineStagingStore,
} from "./store";

/** Encloses the service credential and exports only the two audited producer RPCs. */
export function createInternalPipelineStagingStore(): PipelineStagingStore {
  const admin = createAdminClient();
  const rpcClient: PipelineStagingRpcClient = {
    async rpc(functionName, args) {
      const { data, error } = await admin.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
  return createSupabasePipelineStagingStore(rpcClient);
}
