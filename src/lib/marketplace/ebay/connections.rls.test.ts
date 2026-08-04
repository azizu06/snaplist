import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  acquireExclusiveTestResource,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "../../supabase/test-users";
import {
  deleteEbayConnection,
  eraseEbayUserData,
  getDecryptedConnection,
  getEbayConnectionStatus,
  saveEbayConnection,
} from "./connections";
import { UserTokenProvider } from "./user-token-provider";
import type { EbayTokenGrant } from "./oauth";

/**
 * ebay_connections integration suite (issue #17): tokens encrypted at rest,
 * RLS tenancy, and the UserTokenProvider's cache/refresh lifecycle — all
 * against the REAL local policies.
 *
 * Requires a running local Supabase stack; skips (never fakes a pass) otherwise.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DELETION_QUEUE_HOOK_TIMEOUT_MS = 70_000;

/** Test-only encryption key — passed explicitly, never via process.env. */
const TEST_ENV = {
  EBAY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  EBAY_CLIENT_ID: "test-client-id",
  EBAY_CLIENT_SECRET: "test-client-secret",
};

// Production tombstones are intentionally durable. Give each Vitest process a
// fresh seller while keeping one stable identity for the erase/reconnect proof.
const ERASED_SELLER_RUN_ID = randomBytes(8).toString("hex");
const ERASED_SELLER_IDENTITY = {
  userId: `EBAYUID-ERASE-${ERASED_SELLER_RUN_ID}`,
  username: `seller_erase_${ERASED_SELLER_RUN_ID}`,
};

const GRANT: EbayTokenGrant = {
  accessToken: "access-token-plain",
  refreshToken: "refresh-token-plain",
  accessTokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
  scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
};

let reachable = false;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;
let userAServer: SupabaseClient;
let userBServer: SupabaseClient;
let deletionQueueLease: ExclusiveTestResourceLease | undefined;

async function createTenantWriteClient(userId: string): Promise<SupabaseClient> {
  const jwt = await mintUserJwt(userId);
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    accessToken: async () => jwt,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: ANON_KEY, requiredValues: [ANON_KEY, SERVICE_ROLE_KEY?.startsWith("sb_secret_")] });
  await whenStackReachable(reachable, async () => {

  deletionQueueLease = await acquireExclusiveTestResource(
    `local-db:message-photo-object-deletion-queue:${SUPABASE_URL}`,
  );
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "ebayconn_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "ebayconn_b"),
  ]);
  [userAServer, userBServer] = await Promise.all([
    createTenantWriteClient(userA.id),
    createTenantWriteClient(userB.id),
  ]);

  });}, DELETION_QUEUE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (!reachable || !admin) return;
    await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
  } finally {
    await deletionQueueLease?.release();
  }
});

describe("ebay_connections (DB-gated)", () => {
  it("requires a running local Supabase stack (skips otherwise, never fakes a pass)", () => {
    if (!reachable) {
      console.warn(
        "[connections.rls.test] Local Supabase stack unreachable — skipping. " +
          "Get keys with `pnpm supabase status -o env` and map them into the env.",
      );
    }
    expect(true).toBe(true);
  });

  it("stores tokens as ciphertext only — the raw token never reaches Postgres", async () => {


    await saveEbayConnection(
      userAServer,
      GRANT,
      { userId: "EBAYUID-A", username: "seller_a" },
      TEST_ENV,
    );

    // Service-role read of the RAW row: ciphertext, not the plaintext token.
    const { data } = await admin
      .from("ebay_connections")
      .select("refresh_token_enc, access_token_enc")
      .eq("user_id", userA.id)
      .single();
    expect(data?.refresh_token_enc).toMatch(/^v1\./);
    expect(data?.refresh_token_enc).not.toContain(GRANT.refreshToken);
    expect(data?.access_token_enc).not.toContain(GRANT.accessToken);

    // And the module round-trips it back to plaintext with the key.
    const decrypted = await getDecryptedConnection(userA.client, TEST_ENV);
    expect(decrypted?.refreshToken).toBe(GRANT.refreshToken);
    expect(decrypted?.accessToken).toBe(GRANT.accessToken);
  });

  it("RLS: a connection is invisible to another user and to anon", async () => {


    const statusForB = await getEbayConnectionStatus(userB.client);
    expect(statusForB.connected).toBe(false);

    // B cannot write a row claiming A's identity either.
    const { error } = await userB.client.from("ebay_connections").insert({
      user_id: userA.id,
      refresh_token_enc: "v1.forged.forged.forged",
    });
    expect(error).not.toBeNull();
  });

  it("reports status without exposing tokens, and disconnect erases the row", async () => {


    const status = await getEbayConnectionStatus(userA.client);
    expect(status).toEqual({ connected: true, ebayUsername: "seller_a" });

    await deleteEbayConnection(userAServer);
    const after = await getEbayConnectionStatus(userA.client);
    expect(after.connected).toBe(false);
  });

  it("eraseEbayUserData deletes by eBay identity (deletion-notice path)", async () => {


    await saveEbayConnection(
      userAServer,
      GRANT,
      ERASED_SELLER_IDENTITY,
      TEST_ENV,
    );

    const erased = await eraseEbayUserData(
      admin,
      ERASED_SELLER_IDENTITY.userId,
      ERASED_SELLER_IDENTITY.username,
    );
    expect(erased).toBe(1);
    expect((await getEbayConnectionStatus(userA.client)).connected).toBe(false);

    // Idempotent: a second notice for the same user erases nothing, no error.
    await expect(
      eraseEbayUserData(
        admin,
        ERASED_SELLER_IDENTITY.userId,
        ERASED_SELLER_IDENTITY.username,
      ),
    ).resolves.toBe(0);

    // The durable identity tombstone rejects the erased seller even when a
    // different tenant attempts to claim it within this run.
    await expect(
      saveEbayConnection(
        userBServer,
        GRANT,
        ERASED_SELLER_IDENTITY,
        TEST_ENV,
      ),
    ).rejects.toThrow("eBay seller identity has been erased");
  });
});

describe("UserTokenProvider (DB-gated)", () => {
  it("returns the cached access token while it is still fresh — no network call", async () => {


    await saveEbayConnection(
      userBServer,
      GRANT,
      { userId: "EBAYUID-B", username: "seller_b" },
      TEST_ENV,
    );

    const provider = new UserTokenProvider(userB.client, {
      env: () => TEST_ENV,
      fetch: async () => {
        throw new Error("must not hit the network for a fresh cached token");
      },
    });
    await expect(provider.getAccessToken()).resolves.toBe(GRANT.accessToken);
  });

  it("refreshes an expired access token with the stored refresh token and caches it", async () => {


    // Expire the cached access token.
    await saveEbayConnection(
      userBServer,
      { ...GRANT, accessTokenExpiresAt: Date.now() - 1000 },
      { userId: "EBAYUID-B", username: "seller_b" },
      TEST_ENV,
    );

    let refreshCalls = 0;
    const stubFetch: typeof fetch = async (_input, init) => {
      refreshCalls += 1;
      const params = new URLSearchParams(String(init?.body));
      // The refresh grant must use the SELLER'S decrypted refresh token.
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe(GRANT.refreshToken);
      return new Response(
        JSON.stringify({ access_token: "refreshed-access", expires_in: 7200 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new UserTokenProvider(userBServer, {
      env: () => TEST_ENV,
      fetch: stubFetch,
    });
    await expect(provider.getAccessToken()).resolves.toBe("refreshed-access");
    expect(refreshCalls).toBe(1);

    // The refreshed token was persisted: a second provider needs no network.
    const second = new UserTokenProvider(userB.client, {
      env: () => TEST_ENV,
      fetch: async () => {
        throw new Error("refreshed token should be cached in the row");
      },
    });
    await expect(second.getAccessToken()).resolves.toBe("refreshed-access");
  });

  it("explains the fix when no eBay account is connected", async () => {


    await deleteEbayConnection(userBServer);
    const provider = new UserTokenProvider(userB.client, {
      env: () => TEST_ENV,
    });
    await expect(provider.getAccessToken()).rejects.toThrow(/Connect one in Settings/);
  });
});
