"use client";

import { useMemo } from "react";
import { useSession } from "@clerk/nextjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client — Clerk era (issue #41). A hook (not a factory)
 * because the Clerk session lives in React context; the client injects the
 * Clerk session token per request via the `accessToken` callback, so RLS sees
 * the signed-in user. Uses ONLY the public anon key — never the service-role
 * key (which would bypass RLS and must never reach the browser). Realtime is
 * authorized with the same token, fetched fresh through the callback, so
 * Clerk's short token lifetime is handled by supabase-js re-auth.
 */
export function useSupabaseClient(): SupabaseClient {
  const { session } = useSession();
  return useMemo(
    () =>
      createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          async accessToken() {
            return (await session?.getToken()) ?? null;
          },
        },
      ),
    [session],
  );
}
