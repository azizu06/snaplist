import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { mintUserJwt } from "@/lib/supabase/test-users";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import { saveEbayConnection } from "./connections";
import {
  discoverAndBindEbayPolicyLocation,
  type EbayPolicyLocationBinding,
  type EbayPolicyLocationDiscoveryAdapter,
} from "./policy-location-discovery";
import { createSupabaseEbayPolicyLocationBindingStore } from "./policy-location-store";
import { readEbayPolicyLocationSettingsHint } from "./policy-location-setup";
import { serverRpcHeaders } from "@/lib/supabase/server-rpc-auth";

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVER_RPC_SECRET = process.env.SERVER_RPC_SECRET;
const DATABASE_URL = resolveLocalTestDatabaseUrl();
const TEST_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_REQUEST_TIMEOUT_MS = 2_000;
const STALE_CONNECTION_MESSAGE =
  "The eBay connection changed during policy discovery";
const TEST_ENV = {
  EBAY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

function candidates(prefix: string) {
  const candidate = (kind: string, label: string) => ({
    id: `${prefix}-${kind}`,
    label,
    providerDefault: false,
  });
  return {
    fulfillmentPolicies: [candidate("fulfillment", `${prefix} shipping`)],
    paymentPolicies: [candidate("payment", `${prefix} payment`)],
    returnPolicies: [candidate("return", `${prefix} returns`)],
    inventoryLocations: [candidate("location", `${prefix} warehouse`)],
  };
}

function fixtureAdapter(
  expectedAccountGeneration: () => string,
  prefix: string,
): EbayPolicyLocationDiscoveryAdapter {
  return {
    readCandidates: vi.fn(async (input) => {
      expect(input).toEqual({
        marketplaceId: "EBAY_US",
        accountGeneration: expectedAccountGeneration(),
      });
      return candidates(prefix);
    }),
  };
}

let reachable = false;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});
let lease: ExclusiveTestResourceLease | undefined;
let admin: SupabaseClient;
let tenantAId = "";
let tenantBId = "";
let tenantAServer: SupabaseClient;
let tenantBServer: SupabaseClient;
let tenantAPublic: SupabaseClient;
let storeA: ReturnType<typeof createSupabaseEbayPolicyLocationBindingStore>;
let storeB: ReturnType<typeof createSupabaseEbayPolicyLocationBindingStore>;
let boundedStoreA: ReturnType<typeof createSupabaseEbayPolicyLocationBindingStore>;
let accountGenerationA = "";
let accountGenerationB = "";
let identityA = { userId: "", username: "" };
let identityB = { userId: "", username: "" };
let bindingA: EbayPolicyLocationBinding;
let bindingB: EbayPolicyLocationBinding;

async function tenantClient(
  key: string,
  userId: string,
  requestTimeoutMs?: number,
): Promise<SupabaseClient> {
  const token = await mintUserJwt(userId);
  return createClient(SUPABASE_URL, key, {
    accessToken: async () => token,
    ...(key === SECRET_KEY
      ? { global: { headers: serverRpcHeaders(SERVER_RPC_SECRET!) } }
      : {}),
    auth: { persistSession: false, autoRefreshToken: false },
    ...(requestTimeoutMs
      ? { db: { timeout: requestTimeoutMs } }
      : {}),
  });
}

async function diagnosticStep<T>(
  name: string,
  operation: () => PromiseLike<T>,
): Promise<T> {
  console.info(`[issue-388 diagnosis] ${name}:start`);
  try {
    const result = await operation();
    console.info(`[issue-388 diagnosis] ${name}:settled`);
    return result;
  } catch (error) {
    const kind = error instanceof Error ? error.name : "unknown";
    console.info(`[issue-388 diagnosis] ${name}:rejected:${kind}`);
    throw error;
  }
}

async function cleanExactFixtures(): Promise<void> {
  if (!tenantAId || !tenantBId) return;
  const userIds = [tenantAId, tenantBId];
  const database = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await database.connect();
    await database.query("begin");
    const guards = [
      ["public", "ebay_connections", 2],
      ["private", "ebay_seller_identity_tenants", 4],
      ["private", "ebay_seller_account_generations", 2],
      ["private", "ebay_messaging_account_generations", 2],
    ] as const;
    for (const [schema, table, maximum] of guards) {
      const count = await database.query<{ count: string }>(
        `select count(*)::text as count from ${schema}.${table} where user_id = any($1::text[])`,
        [userIds],
      );
      if (Number(count.rows[0]?.count ?? 0) > maximum) {
        throw new Error(`STOP: unexpected #388 fixture count in ${schema}.${table}`);
      }
    }

    await database.query(
      "delete from public.ebay_connections where user_id = any($1::text[])",
      [userIds],
    );
    for (const table of [
      "ebay_seller_identity_tenants",
      "ebay_seller_account_generations",
      "ebay_messaging_account_generations",
    ]) {
      await database.query(
        `delete from private.${table} where user_id = any($1::text[])`,
        [userIds],
      );
    }
    const residue = await database.query<{ count: string }>(
      `select (
        (select count(*) from public.ebay_connections where user_id = any($1::text[]))
        + (select count(*) from private.ebay_seller_identity_tenants where user_id = any($1::text[]))
        + (select count(*) from private.ebay_seller_account_generations where user_id = any($1::text[]))
        + (select count(*) from private.ebay_messaging_account_generations where user_id = any($1::text[]))
      )::text as count`,
      [userIds],
    );
    if (Number(residue.rows[0]?.count ?? 0) !== 0) {
      throw new Error("STOP: #388 fixture cleanup left database residue");
    }
    await database.query("commit");
  } catch (error) {
    await database.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await database.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: PUBLISHABLE_KEY, requiredValues: [PUBLISHABLE_KEY?.startsWith("sb_publishable_"), SECRET_KEY?.startsWith("sb_secret_"), SERVER_RPC_SECRET, ["127.0.0.1", "localhost", "::1"].includes(new URL(SUPABASE_URL).hostname)] });
  await whenStackReachable(reachable, async () => {

  lease = await acquireExclusiveTestResource(
    `local-db:ebay-policy-location-binding:${SUPABASE_URL}`,
  );
  const suffix = `${Date.now()}_${randomBytes(5).toString("hex")}`;
  tenantAId = `user_test_ebay_policy_a_${suffix}`;
  tenantBId = `user_test_ebay_policy_b_${suffix}`;
  identityA = {
    userId: `EBAYUID-POLICY-A-${suffix}`,
    username: `policy_a_${suffix}`,
  };
  identityB = {
    userId: `EBAYUID-POLICY-B-${suffix}`,
    username: `policy_b_${suffix}`,
  };
  admin = createClient(SUPABASE_URL, SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let boundedTenantAServer: SupabaseClient;
  [tenantAServer, tenantBServer, tenantAPublic, boundedTenantAServer] = await Promise.all([
    tenantClient(SECRET_KEY!, tenantAId),
    tenantClient(SECRET_KEY!, tenantBId),
    tenantClient(PUBLISHABLE_KEY!, tenantAId),
    tenantClient(SECRET_KEY!, tenantAId, DIAGNOSTIC_REQUEST_TIMEOUT_MS),
  ]);
  storeA = createSupabaseEbayPolicyLocationBindingStore(tenantAServer);
  storeB = createSupabaseEbayPolicyLocationBindingStore(tenantBServer);
  boundedStoreA = createSupabaseEbayPolicyLocationBindingStore(
    boundedTenantAServer,
  );

  await Promise.all([
    saveEbayConnection(
      tenantAServer,
      {
        accessToken: "policy-access-a",
        refreshToken: "policy-refresh-a",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        scopes: ["https://api.ebay.com/oauth/api_scope/sell.account.readonly"],
      },
      identityA,
      TEST_ENV,
    ),
    saveEbayConnection(
      tenantBServer,
      {
        accessToken: "policy-access-b",
        refreshToken: "policy-refresh-b",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        scopes: ["https://api.ebay.com/oauth/api_scope/sell.account.readonly"],
      },
      identityB,
      TEST_ENV,
    ),
  ]);
  const [contextA, contextB] = await Promise.all([
    storeA.readConnectionContext(),
    storeB.readConnectionContext(),
  ]);
  if (!contextA || !contextB) throw new Error("#388 test connections are required");
  accountGenerationA = contextA.accountGeneration;
  accountGenerationB = contextB.accountGeneration;

  });}, TEST_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (reachable) await cleanExactFixtures();
  } finally {
    await lease?.release();
  }
}, TEST_TIMEOUT_MS);

describe("eBay policy/location binding (DB-gated)", () => {
  it("requires the authorized local Supabase stack and never substitutes a fake DB", () => {
    if (!reachable) {
      console.warn(
        "[policy-location-store.rls.test] Local Supabase unavailable — skipping. "
        + "Run only inside the separately granted exclusive DB window.",
      );
    }
    expect(true).toBe(true);
  });

  it("persists injected offline discovery for two tenants without sharing seller IDs", async () => {


    [bindingA, bindingB] = await Promise.all([
      discoverAndBindEbayPolicyLocation({
        marketplaceId: "EBAY_US",
        adapter: fixtureAdapter(() => accountGenerationA, "seller-a"),
        store: storeA,
        now: () => Date.parse("2026-07-22T22:30:00Z"),
      }),
      discoverAndBindEbayPolicyLocation({
        marketplaceId: "EBAY_US",
        adapter: fixtureAdapter(() => accountGenerationB, "seller-b"),
        store: storeB,
        now: () => Date.parse("2026-07-22T22:31:00Z"),
      }),
    ]);

    const hiddenA = await tenantBServer
      .from("ebay_connections")
      .select("policy_location_bindings")
      .eq("user_id", tenantAId)
      .maybeSingle();
    const rows = await admin
      .from("ebay_connections")
      .select("user_id, policy_location_bindings")
      .in("user_id", [tenantAId, tenantBId]);

    expect(hiddenA).toMatchObject({ data: null, error: null });
    expect(rows.error).toBeNull();
    expect(bindingA.fulfillmentPolicy).toMatchObject({
      selectedId: "seller-a-fulfillment",
    });
    expect(bindingB.fulfillmentPolicy).toMatchObject({
      selectedId: "seller-b-fulfillment",
    });
    const serialized = JSON.stringify(rows.data);
    expect(serialized).not.toContain("policy-refresh");
    expect(serialized).not.toContain("policy-access");
    expect(serialized).not.toContain("address");
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain("description");
    expect(JSON.stringify(bindingA)).not.toContain("seller-b");
    expect(JSON.stringify(bindingB)).not.toContain("seller-a");
  });

  it("keeps the save capability server-only, tenant-derived, and display-safe", async () => {


    const publicAttempt = await diagnosticStep(
      "public-authorization-rpc",
      () => tenantAPublic.rpc(
        "save_ebay_policy_location_binding",
        {
          p_marketplace_id: "EBAY_US",
          p_connection_generation: bindingA.connectionGeneration,
          p_binding: bindingA,
        },
      ).abortSignal(AbortSignal.timeout(DIAGNOSTIC_REQUEST_TIMEOUT_MS)),
    );
    expect(publicAttempt.error?.message).toContain("Server API authorization");

    const unsafeAttempt = await diagnosticStep(
      "unsafe-binding-rpc",
      () => tenantAServer.rpc(
        "save_ebay_policy_location_binding",
        {
          p_marketplace_id: "EBAY_US",
          p_connection_generation: bindingA.connectionGeneration,
          p_binding: {
            ...bindingA,
            description: "private provider description",
          },
        },
      ).abortSignal(AbortSignal.timeout(DIAGNOSTIC_REQUEST_TIMEOUT_MS)),
    );
    expect(unsafeAttempt.error?.message).toContain("binding fields are invalid");

    const crossTenantAttempt = await diagnosticStep(
      "stale-generation-cross-tenant-rpc",
      () => tenantAServer.rpc(
        "save_ebay_policy_location_binding",
        {
          p_marketplace_id: "EBAY_US",
          p_connection_generation: bindingB.connectionGeneration,
          p_binding: bindingB,
        },
      ).abortSignal(AbortSignal.timeout(DIAGNOSTIC_REQUEST_TIMEOUT_MS)),
    );
    expect(crossTenantAttempt.error).toMatchObject({
      code: "PT409",
      message: STALE_CONNECTION_MESSAGE,
    });

    const rowA = await admin
      .from("ebay_connections")
      .select("policy_location_bindings")
      .eq("user_id", tenantAId)
      .single();
    expect(rowA.data?.policy_location_bindings).toEqual({ EBAY_US: bindingA });
  }, TEST_TIMEOUT_MS);

  it("advances generation, clears discovery, and rejects a stale save on reconnect", async () => {


    const before = await diagnosticStep(
      "reconnect-read-before",
      () => storeA.readConnectionContext(),
    );
    expect(before).not.toBeNull();
    await diagnosticStep(
      "reconnect-save",
      () => saveEbayConnection(
        tenantAServer,
        {
          accessToken: "policy-access-a-reconnected",
          refreshToken: "policy-refresh-a-reconnected",
          accessTokenExpiresAt: Date.now() + 3_600_000,
          scopes: ["https://api.ebay.com/oauth/api_scope/sell.account.readonly"],
        },
        identityA,
        TEST_ENV,
      ),
    );
    const after = await diagnosticStep(
      "reconnect-read-after",
      () => storeA.readConnectionContext(),
    );

    expect(after?.accountGeneration).toBe(before?.accountGeneration);
    expect(after?.connectionGeneration).not.toBe(before?.connectionGeneration);
    await expect(
      diagnosticStep(
        "stale-generation-store-rpc",
        () => boundedStoreA.saveBinding(bindingA),
      ),
    ).rejects.toThrow(STALE_CONNECTION_MESSAGE);

    const rowA = await admin
      .from("ebay_connections")
      .select("policy_location_bindings")
      .eq("user_id", tenantAId)
      .single();
    expect(rowA.data?.policy_location_bindings).toEqual({});
  }, TEST_TIMEOUT_MS);

  /**
   * The Settings hint (issue #694) is a read of this same tenant-owned column,
   * so it inherits RLS rather than adding a second path to the binding. This
   * proves that by giving the two tenants DIFFERENT setup states: if the read
   * ever crossed tenants, one of these two assertions reports the other
   * seller's state.
   */
  it("shows each tenant only their own eBay policy setup in Settings", async () => {
    const contextA = await storeA.readConnectionContext();
    expect(contextA).not.toBeNull();
    const missingPayment = {
      ...bindingA,
      state: "setupRequired",
      connectionGeneration: contextA!.connectionGeneration,
      paymentPolicy: { state: "setupRequired", selectedId: null, candidates: [] },
    };
    const written = await admin
      .from("ebay_connections")
      .update({ policy_location_bindings: { EBAY_US: missingPayment } })
      .eq("user_id", tenantAId);
    expect(written.error).toBeNull();

    const [hintA, hintB] = await Promise.all([
      readEbayPolicyLocationSettingsHint({
        marketplaceId: "EBAY_US",
        store: storeA,
      }),
      readEbayPolicyLocationSettingsHint({
        marketplaceId: "EBAY_US",
        store: storeB,
      }),
    ]);

    expect(hintA).toMatchObject({
      state: "setupRequired",
      missing: ["paymentPolicy"],
    });
    expect(hintB).toMatchObject({ state: "ready", message: null });
    expect(JSON.stringify(hintA)).not.toContain("seller-b");
    expect(JSON.stringify(hintB)).not.toContain("seller-a");
  }, TEST_TIMEOUT_MS);
});
