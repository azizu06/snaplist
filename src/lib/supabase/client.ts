"use client";

import { useEffect, useMemo, useRef } from "react";
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
 *
 * STABLE IDENTITY (issue #121): the client is memoized on `[]`, not on the
 * Clerk `session`. Clerk swaps the session OBJECT reference on re-auth and on
 * every server-action `revalidatePath`, so keying the client on `session` used
 * to rebuild the whole client on each swap. Consumers that key a Realtime
 * subscribe effect on the client (the inbox) then tore down and re-subscribed a
 * same-named channel; that teardown/rejoin race left the channel stuck short of
 * SUBSCRIBED and the inbox indicator wrongly read "Live updates unavailable"
 * until a reload/Retry. Creating the client once and reading the LATEST session
 * through a ref keeps the token fresh (the callback reads `sessionRef.current`
 * at request time) without ever churning the client or the channel.
 */
export function useSupabaseClient(): SupabaseClient {
  const { session } = useSession();
  // Latest Clerk session, read by the accessToken callback at request time.
  // Updating in an effect (not during render) keeps render side-effect-free;
  // the callback only fires on later async requests, after the effect commits.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  return useMemo(() => {
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      // accessToken reads sessionRef only when supabase-js invokes it for a
      // request or Realtime re-auth, never during React render, so the
      // read-ref-during-render rule is a false positive on this options object.
      // eslint-disable-next-line react-hooks/refs
      {
        async accessToken() {
          return (await sessionRef.current?.getToken()) ?? null;
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
    // Created once per mount; the accessToken callback reads the live session
    // via sessionRef, so a swapped session never rebuilds the client.
  }, []);
}
