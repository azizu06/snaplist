import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AssistedExportHandoffGateway } from "@/lib/mobile-api";
import {
  loadExportHandoffPack,
  markExportShared,
  recordExportHandoff,
  undoExportShared,
} from "./handoff";

/**
 * Binds the #580 assisted-export seam to the native transport (issue #581).
 *
 * This adds no authority. Each call builds a client scoped to the caller's own
 * bearer, so RLS and the guarded RPCs decide what is allowed exactly as they do
 * for every other caller. There is deliberately no service-role path here: a
 * handoff receipt is the seller's own claim about their own item, and nothing
 * about serving it to a phone makes it a privileged operation.
 */
export function createSupabaseAssistedExportGateway(
  clientFor: (bearerToken: string) => SupabaseClient,
): AssistedExportHandoffGateway {
  return {
    load: (input) =>
      loadExportHandoffPack(clientFor(input.bearerToken), {
        itemId: input.itemId,
        reviewContentRevision: input.reviewContentRevision,
      }),
    recordHandoff: (input) =>
      recordExportHandoff(clientFor(input.bearerToken), input),
    markShared: (input) =>
      markExportShared(clientFor(input.bearerToken), input),
    undoShared: (input) =>
      undoExportShared(clientFor(input.bearerToken), input),
  };
}

export function createConfiguredAssistedExportGateway(input: {
  supabaseURL: string;
  anonKey: string;
}): AssistedExportHandoffGateway {
  return createSupabaseAssistedExportGateway((bearerToken) =>
    createClient(input.supabaseURL, input.anonKey, {
      accessToken: async () => bearerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
}
