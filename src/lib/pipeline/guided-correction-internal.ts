import "server-only";
import { createAdminClient } from "../supabase/admin";
import type { GuidedCorrectionCompletionRpcClient } from "./guided-correction-completion";

/**
 * Encloses the service credential and exposes only the one fixed guided-
 * correction completion function. Callers never receive a generic admin client.
 */
export function createInternalGuidedCorrectionCompletionRpcClient(): GuidedCorrectionCompletionRpcClient {
  const admin = createAdminClient();
  return {
    async rpc(functionName, args) {
      const { data, error } = await admin.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
}
