import { cookies } from "next/headers";
import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * Clerk auth seam (issue #41) — the ONLY way server code asks "who is calling?".
 *
 * Replaces supabase.auth.getUser(): with the Supabase client configured via
 * accessToken (third-party auth), its auth methods are disabled by design, and
 * identity now lives in Clerk. `userId` is the Clerk text id — the same value
 * RLS compares via public.clerk_user_id(), and the prefix for storage paths.
 */

/** The requesting user's Clerk id, or null when signed out. */
export async function getUserId(): Promise<string | null> {
  // Read the request cookie store BEFORE touching Clerk: during `next build`'s
  // prerender pass, `cookies()` bails the route out to dynamic rendering before
  // Clerk's env validation can throw on secret-less builds (CI, Docker image).
  // Same trick the Supabase server client used pre-Clerk.
  await cookies();
  const { userId } = await auth();
  return userId;
}

/** Email for display surfaces (Settings). Extra Clerk API call — use sparingly. */
export async function getUserEmail(): Promise<string | null> {
  await cookies();
  const user = await currentUser();
  return user?.primaryEmailAddress?.emailAddress ?? null;
}
