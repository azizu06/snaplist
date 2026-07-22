import { createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMobileApiHandler } from "@/lib/mobile-api";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
} from "@/lib/supabase/test-users";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import { createMobileEbayOauthOperations } from "./mobile-oauth";
import { createSupabaseMobileEbayOauthSessionStore } from "./mobile-oauth-store";

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_TIMEOUT_MS = 30_000;
const OAUTH_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const DATABASE_URL = resolveLocalTestDatabaseUrl();

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SECRET_KEY?.startsWith("sb_secret_")) return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: ANON_KEY },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let reachable = false;
let lease: ExclusiveTestResourceLease | undefined;
let admin: SupabaseClient;
let api: ReturnType<typeof createMobileApiHandler>;
let tenantAId = "";
let tenantBId = "";
let tenantAToken = "";
let tenantBToken = "";
const exchangeCode = vi.fn();
const fetchIdentity = vi.fn();

function startSession(token: string, idempotencyKey: string) {
  return api(
    new Request("http://localhost/v1/ebay/oauth/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey,
      },
    }),
  );
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;

  lease = await acquireExclusiveTestResource(
    `local-db:mobile-ebay-sandbox-oauth:${SUPABASE_URL}`,
  );
  admin = createClient(SUPABASE_URL, SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const suffix = `${Date.now()}_${randomBytes(5).toString("hex")}`;
  tenantAId = `user_test_mobile_ebay_a_${suffix}`;
  tenantBId = `user_test_mobile_ebay_b_${suffix}`;
  [tenantAToken, tenantBToken] = await Promise.all([
    mintUserJwt(tenantAId),
    mintUserJwt(tenantBId),
  ]);

  exchangeCode.mockResolvedValue({
    accessToken: "mobile-ebay-access-token-387",
    refreshToken: "mobile-ebay-refresh-token-387",
    accessTokenExpiresAt: Date.now() + 2 * 60 * 60_000,
    scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
  });
  fetchIdentity.mockResolvedValue({
    userId: "EBAYUID-MOBILE-387",
    username: "sandbox_mobile_seller_387",
  });
  const ebayOauth = createMobileEbayOauthOperations({
    store: createSupabaseMobileEbayOauthSessionStore({
      supabaseURL: SUPABASE_URL,
      secretKey: SECRET_KEY!,
    }),
    env: () => ({
      EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      EBAY_CLIENT_ID: "sandbox-client-id",
      EBAY_CLIENT_SECRET: "sandbox-client-secret",
      EBAY_RU_NAME: "sandbox-ru-name",
      EBAY_TOKEN_ENCRYPTION_KEY: OAUTH_ENCRYPTION_KEY,
      EBAY_MOBILE_OAUTH_RETURN_URL:
        "https://snaplist.example/mobile/ebay/oauth",
    }),
    exchangeCode,
    fetchIdentity,
  });
  api = createMobileApiHandler({
    async authenticate(token) {
      if (token === tenantAToken) return { userId: tenantAId };
      if (token === tenantBToken) return { userId: tenantBId };
      throw new Error("forged test bearer");
    },
    ebayOauth,
    worker: {
      async consume() {
        throw new Error("not available at the OAuth seam");
      },
    },
    requestId: () => "req_mobile_ebay_387",
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (reachable && admin) {
      await cleanupClerkTestUsers(admin, [tenantAId, tenantBId]);
      const database = new Client({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 2_000,
      });
      try {
        await database.connect();
        await database.query("begin");
        for (const table of [
          "ebay_seller_identity_tenants",
          "ebay_seller_account_generations",
          "ebay_messaging_account_generations",
        ]) {
          await database.query(
            `delete from private.${table} where user_id = any($1::text[])`,
            [[tenantAId, tenantBId]],
          );
        }
        await database.query("commit");
      } catch (error) {
        await database.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        await database.end().catch(() => undefined);
      }
    }
  } finally {
    await lease?.release();
  }
});

describe("mobile eBay Sandbox OAuth (DB-gated)", () => {
  it("requires the authorized local Supabase stack and never substitutes a fake DB", () => {
    if (!reachable) {
      console.warn(
        "[mobile-oauth.rls.test] Local Supabase unavailable — DB proof skipped. "
        + "Run only inside the separately granted exclusive DB window.",
      );
    }
    expect(true).toBe(true);
  });

  it("replays one session per verified tenant and key while separating another tenant", async () => {
    if (!reachable) return;
    const idempotencyKey = randomUUID();
    const beforeCreate = Date.now();

    const first = await startSession(tenantAToken, idempotencyKey);
    const replay = await startSession(tenantAToken, idempotencyKey);
    const otherTenant = await startSession(tenantBToken, idempotencyKey);
    const firstBody = await first.json();
    const replayBody = await replay.json();
    const otherBody = await otherTenant.json();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(otherTenant.status).toBe(201);
    expect(replayBody).toEqual(firstBody);
    expect(otherBody.data.sessionId).not.toBe(firstBody.data.sessionId);
    const authoritativeExpiry = Date.parse(firstBody.data.expiresAt);
    expect(authoritativeExpiry).toBeGreaterThanOrEqual(beforeCreate + 9 * 60_000);
    expect(authoritativeExpiry).toBeLessThanOrEqual(Date.now() + 11 * 60_000);
    expect(JSON.stringify([firstBody, replayBody, otherBody])).not.toMatch(
      /access.token|refresh.token|client.secret/i,
    );

    const tenantClient = createClient(SUPABASE_URL, ANON_KEY!, {
      accessToken: async () => tenantAToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await tenantClient.from("ebay_oauth_sessions").select("*");
    expect(error).not.toBeNull();
  });

  it("rejects a mixed-tenant callback before any provider or connection mutation", async () => {
    if (!reachable) return;
    const [tenantA, tenantB] = await Promise.all([
      startSession(tenantAToken, randomUUID()),
      startSession(tenantBToken, randomUUID()),
    ]);
    const stateA = new URL(
      (await tenantA.json()).data.authorizationUrl,
    ).searchParams.get("state")!;
    const stateB = new URL(
      (await tenantB.json()).data.authorizationUrl,
    ).searchParams.get("state")!;
    const partsA = stateA.split(".");
    const partsB = stateB.split(".");
    const mixedPayload = [partsA[0], partsA[1], partsB[2]].join(".");
    const stateKey = Buffer.from(hkdfSync(
      "sha256",
      Buffer.from(OAUTH_ENCRYPTION_KEY, "base64"),
      Buffer.alloc(0),
      Buffer.from("snaplist:ebay-mobile-oauth-state:v1"),
      32,
    ));
    const mixedState = `${mixedPayload}.${createHmac("sha256", stateKey)
      .update(mixedPayload)
      .digest("base64url")}`;
    const callsBefore = exchangeCode.mock.calls.length;

    const callback = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(mixedState)}&code=provider-code`,
      ),
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=wrong_tenant",
    );
    expect(exchangeCode).toHaveBeenCalledTimes(callsBefore);
    const { data: connections } = await admin
      .from("ebay_connections")
      .select("user_id")
      .in("user_id", [tenantAId, tenantBId]);
    expect(connections).toEqual([]);
  });

  it("replays the durable terminal outcome instead of a conflicting callback query", async () => {
    if (!reachable) return;
    const session = await startSession(tenantAToken, randomUUID());
    const sessionBody = await session.json();
    const state = new URL(sessionBody.data.authorizationUrl).searchParams.get(
      "state",
    )!;
    const providerCallsBefore = exchangeCode.mock.calls.length;

    const decline = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state)}&error=access_denied`,
      ),
    );
    const conflictingReplay = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state)}`,
      ),
    );

    expect(decline.status).toBe(303);
    expect(conflictingReplay.status).toBe(303);
    expect(decline.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=declined",
    );
    expect(conflictingReplay.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=declined",
    );
    expect(exchangeCode).toHaveBeenCalledTimes(providerCallsBefore);
    const { data: rows, error } = await admin
      .from("ebay_oauth_sessions")
      .select("status")
      .eq("id", sessionBody.data.sessionId);
    expect(error).toBeNull();
    expect(rows).toEqual([{ status: "declined" }]);
  });

  it("turns a successful callback replay into exactly one encrypted connection", async () => {
    if (!reachable) return;
    const session = await startSession(tenantAToken, randomUUID());
    const state = new URL(
      (await session.json()).data.authorizationUrl,
    ).searchParams.get("state")!;
    const providerCallsBefore = exchangeCode.mock.calls.length;
    const callback = () => api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state)}&code=sandbox-provider-code`,
      ),
    );

    const first = await callback();
    const replay = await callback();

    expect(first.status).toBe(303);
    expect(replay.status).toBe(303);
    expect(first.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=connected",
    );
    expect(replay.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=connected",
    );
    expect(exchangeCode).toHaveBeenCalledTimes(providerCallsBefore + 1);
    const { data: rows, error } = await admin
      .from("ebay_connections")
      .select("user_id, refresh_token_enc, access_token_enc")
      .eq("user_id", tenantAId);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0].refresh_token_enc).toMatch(/^v1\./);
    expect(rows?.[0].access_token_enc).toMatch(/^v1\./);
    expect(JSON.stringify([rows, first.headers, replay.headers])).not.toMatch(
      /mobile-ebay-(?:access|refresh)-token-387|sandbox-provider-code/,
    );
  });
});
