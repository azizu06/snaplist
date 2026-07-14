import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";

/**
 * Clerk-era test identities for the DB-gated suites (issue #41).
 *
 * With Clerk as the identity provider there are no auth.users rows to provision:
 * identity is just a signed JWT whose `sub` is a Clerk-style TEXT id, and RLS
 * compares that sub to the text user_id columns (public.clerk_user_id()).
 *
 * So the tests mint their own JWTs, signed with the LOCAL stack's JWT secret —
 * exactly what Supabase does to validate third-party tokens, minus the Clerk
 * round-trip. This keeps the suites offline-deterministic and key-free while
 * still exercising the REAL policies in Postgres: signature, role mapping, and
 * the sub/user_id comparison are all live.
 *
 * Cleanup note: dropping the auth.users FKs removed the delete-user cascade,
 * so cleanup deletes owned domain rows explicitly (children before items).
 */

const LOCAL_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ??
  // The supabase CLI's fixed local development secret (public, local-only).
  "super-secret-jwt-token-with-at-least-32-characters-long";

export interface ClerkTestUser {
  /** Clerk-style text id — what RLS compares against user_id. */
  id: string;
  /** Supabase client whose requests carry this user's JWT (RLS-scoped). */
  client: SupabaseClient;
}

/** Sign a Supabase-acceptable JWT for a Clerk-style subject. */
export async function mintUserJwt(sub: string): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(LOCAL_JWT_SECRET));
}

/** Provision a test identity: a Clerk-style id + an RLS-scoped client for it. */
export async function provisionClerkTestUser(
  supabaseUrl: string,
  anonKey: string,
  label: string,
): Promise<ClerkTestUser> {
  const id = `user_test_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const jwt = await mintUserJwt(id);
  const client = createClient(supabaseUrl, anonKey, {
    accessToken: async () => jwt,
  });
  return { id, client };
}

/** Tables that carry user_id, children-first so item FKs never block deletes. */
const OWNED_TABLES = [
  "prediction_logs",
  "message_attachments",
  "messages",
  "listings",
  "embeddings",
  "user_settings",
  "ebay_connections",
  "items",
] as const;

/**
 * Delete every domain row owned by the given test ids (service-role client —
 * replaces the auth.users on-delete cascade the Clerk migration removed).
 */
export async function cleanupClerkTestUsers(
  admin: SupabaseClient,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  for (const table of OWNED_TABLES) {
    await admin.from(table).delete().in("user_id", userIds);
  }
}
