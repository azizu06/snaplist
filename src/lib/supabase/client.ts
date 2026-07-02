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
  return useMemo(() => {
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        async accessToken() {
          return (await session?.getToken()) ?? null;
        },
      },
    );
    // WORKAROUND (supabase-js 2.108.1): when constructed with an `accessToken`
    // callback the constructor internally calls `realtime.setAuth(<token>)`
    // WITH an argument, which flips RealtimeClient's `_manuallySetToken` to
    // true and permanently disables callback-driven token refresh for the
    // Realtime connection — the channel silently dies when the first
    // short-lived Clerk JWT expires (~60s) and the inbox reads "Connecting…"
    // forever. An ARGUMENT-LESS `setAuth()` clears that manual-token flag and
    // restores the accessToken-callback refresh path. Scheduled as a microtask
    // (setAuth is async; don't block render) right after construction. Remove
    // once upstream stops setting `_manuallySetToken` from the constructor.
    void Promise.resolve()
      .then(() => client.realtime.setAuth())
      .catch((error) => {
        console.warn("[realtime] setAuth refresh-path reset failed", error);
      });
    return client;
  }, [session]);
}
