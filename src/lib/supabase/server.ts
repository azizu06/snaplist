import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { getEnv } from "@/lib/env";

/**
 * Server-side Supabase client for the Next.js App Router (Server Components,
 * Route Handlers, Server Actions) — Clerk era (issue #41).
 *
 * SECURITY: uses the public anon key plus the caller's CLERK session token via
 * the `accessToken` callback (Supabase third-party auth), so every query runs
 * AS THE SIGNED-IN USER and is subject to RLS — the tenancy seam is unchanged
 * in shape, only the token issuer moved. Never the service-role key.
 *
 * NOTE: with `accessToken` configured, supabase.auth.* methods are disabled by
 * supabase-js. Identity questions go through src/lib/auth.ts (getUserId).
 */
export async function createClient() {
  // cookies() BEFORE env: bails prerender to dynamic on secret-less builds
  // (CI / Docker) before env validation can throw. Same property as pre-Clerk.
  await cookies();
  const env = getEnv();

  return createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      async accessToken() {
        return (await auth()).getToken();
      },
    },
  );
}
