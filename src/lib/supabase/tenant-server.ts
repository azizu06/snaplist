import "server-only";
import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { serverRpcHeaders } from "./server-rpc-auth";

export async function createTenantServerClient() {
  const env = getEnv();
  const apiKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey?.startsWith("sb_secret_")) {
    throw new Error(
      "A Supabase secret API key is required for tenant-bound server writes.",
    );
  }
  const token = await (await auth()).getToken();
  if (!token) throw new Error("A seller session is required for server writes.");

  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, apiKey, {
    accessToken: async () => token,
    global: { headers: serverRpcHeaders(env.SERVER_RPC_SECRET ?? "") },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
