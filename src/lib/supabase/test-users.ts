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

async function mintTestJwt(
  sub: string,
  claims: Record<string, string>,
  lifetime: "60s" | "1h",
): Promise<string> {
  return new SignJWT({ role: "authenticated", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(lifetime)
    .sign(new TextEncoder().encode(LOCAL_JWT_SECRET));
}

export interface ClerkTestUser {
  /** Clerk-style text id — what RLS compares against user_id. */
  id: string;
  /** Supabase client whose requests carry this user's JWT (RLS-scoped). */
  client: SupabaseClient;
}

/** Sign a Supabase-acceptable JWT for a Clerk-style subject. */
export async function mintUserJwt(sub: string): Promise<string> {
  return mintTestJwt(sub, {}, "1h");
}

/** Sign the exact internal claims accepted by verified-guest DB capabilities. */
export async function mintVerifiedGuestJwt(
  sub: string,
  capabilityId: string,
): Promise<string> {
  return mintTestJwt(
    sub,
    {
      actor: "verified_guest",
      cap_id: capabilityId,
      snaplist_operation_channel: "verified_guest_publishable",
    },
    "60s",
  );
}

/** Mint intentionally invalid claim combinations for fail-closed DB tests. */
export async function mintInvalidVerifiedGuestJwt(
  sub: string,
  claims: {
    actor?: string;
    capabilityId?: string;
    operationChannel?: string | null;
  },
): Promise<string> {
  return mintTestJwt(
    sub,
    {
      ...(claims.actor === undefined ? {} : { actor: claims.actor }),
      ...(claims.capabilityId === undefined
        ? {}
        : { cap_id: claims.capabilityId }),
      ...(claims.operationChannel === null
        ? {}
        : {
            snaplist_operation_channel:
              claims.operationChannel ?? "verified_guest_publishable",
          }),
    },
    "60s",
  );
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

/**
 * Satisfies the #524 device fence for a test account.
 *
 * Since #524, reserving the *included* first AI run requires a durably reserved
 * account/device claim, so a test that expects a free run must say which
 * account has passed the fence. Call this only where the free run is incidental
 * setup; a test that means to prove the fence must not call it.
 */
export async function grantIncludedOfferDeviceClaim(
  admin: SupabaseClient,
  userId: string,
): Promise<void> {
  // Through the audited RPC, not a table insert: no key holds direct write
  // authority on the fence, so the fixture cannot mint a claim the product
  // could not have minted itself.
  const { error } = await admin.rpc("begin_included_offer_claim", {
    p_app_attest_key_id: `fixture-key-${userId}`,
    p_claim_id: crypto.randomUUID(),
    p_idempotency_key: crypto.randomUUID(),
    p_state: "reserved",
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
}

/** Tables that carry user_id, children-first so item FKs never block deletes. */
const OWNED_TABLES = [
  "included_offer_device_claims",
  "included_offer_support_overrides",
  "billing_checkout_reservations",
  "ai_item_credit_reservations",
  "ai_item_allowance_periods",
  "subscriptions",
  "billing_customers",
  "prediction_logs",
  "message_attachments",
  "messages",
  "listings",
  "embeddings",
  "user_settings",
  "ebay_oauth_sessions",
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
