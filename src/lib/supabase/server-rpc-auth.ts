import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SERVER_RPC_AUTH_HEADER = "x-snaplist-server-auth";

export function serverRpcHeaders(secret: string): Record<string, string> {
  const value = secret.trim();
  if (value.length < 32) {
    throw new Error("SERVER_RPC_SECRET must contain at least 32 characters.");
  }
  return { [SERVER_RPC_AUTH_HEADER]: value };
}

export function createServerRpcClient(input: {
  supabaseURL: string;
  apiKey: string;
  serverRpcSecret: string;
  bearerToken?: string;
}): SupabaseClient {
  const bearerToken = input.bearerToken;
  return createClient(input.supabaseURL, input.apiKey, {
    ...(bearerToken ? { accessToken: async () => bearerToken } : {}),
    global: { headers: serverRpcHeaders(input.serverRpcSecret) },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
