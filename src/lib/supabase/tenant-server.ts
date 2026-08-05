import "server-only";
import { auth } from "@clerk/nextjs/server";
import { getEnv } from "@/lib/env";
import { createServerRpcClient } from "./server-rpc-auth";

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

  return createServerRpcClient({
    supabaseURL: env.NEXT_PUBLIC_SUPABASE_URL,
    apiKey,
    serverRpcSecret: env.SERVER_RPC_SECRET ?? "",
    bearerToken: token,
  });
}
