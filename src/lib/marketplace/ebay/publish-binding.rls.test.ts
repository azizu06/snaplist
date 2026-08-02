import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { StubPipeline } from "@/lib/pipeline/stub";
import { runPipelineAndPersist } from "@/lib/pipeline/persist";
import { saveEbayConnection } from "./connections";
import { HttpEbayAdapter } from "./http";
import type { EbayPolicyLocationBinding } from "./policy-location-contract";
import { createSupabaseEbayPolicyLocationBindingStore } from "./policy-location-store";
import { publishListingToEbay } from "./publish";
import { UserTokenProvider } from "./user-token-provider";

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
const DATABASE_URL = resolveLocalTestDatabaseUrl();
const TEST_TIMEOUT_MS = 30_000;
const EBAY_BASE_URL = "https://mock-ebay.invalid";
const TEST_ENV = {
  EBAY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};
const SHARED_ENV_FALLBACK = {
  ...TEST_ENV,
  EBAY_BASE_URL,
  EBAY_MARKETPLACE_ID: "EBAY_US",
  EBAY_FULFILLMENT_POLICY_ID: "shared-env-fulfillment",
  EBAY_PAYMENT_POLICY_ID: "shared-env-payment",
  EBAY_RETURN_POLICY_ID: "shared-env-return",
  EBAY_MERCHANT_LOCATION_KEY: "shared-env-location",
};

interface RecordedCall {
  url: string;
  init: RequestInit;
}

let reachable = false;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});
let lease: ExclusiveTestResourceLease | undefined;
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;
let serverA: SupabaseClient;
let serverB: SupabaseClient;
let ebayIdentityA: { userId: string; username: string };
let ebayIdentityB: { userId: string; username: string };
const uploadedPhotos: string[] = [];async function tenantServerClient(userId: string): Promise<SupabaseClient> {
  const token = await mintUserJwt(userId);
  return createClient(SUPABASE_URL, SECRET_KEY!, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function boundChoice(prefix: string, kind: string) {
  const id = `${prefix}-${kind}`;
  return {
    state: "bound" as const,
    selectedId: id,
    candidates: [
      {
        id,
        label: `${prefix} ${kind}`,
        providerDefault: false,
      },
    ],
  };
}

function readyBinding(
  prefix: string,
  connectionGeneration: string,
): EbayPolicyLocationBinding {
  return {
    state: "ready",
    marketplaceId: "EBAY_US",
    connectionGeneration,
    fulfillmentPolicy: boundChoice(prefix, "fulfillment"),
    paymentPolicy: boundChoice(prefix, "payment"),
    returnPolicy: boundChoice(prefix, "return"),
    inventoryLocation: boundChoice(prefix, "location"),
    discoveredAt: "2026-07-27T12:00:00.000Z",
  };
}

function setupRequiredBinding(
  connectionGeneration: string,
): EbayPolicyLocationBinding {
  const choice = {
    state: "setupRequired" as const,
    selectedId: null,
    candidates: [],
  };
  return {
    state: "setupRequired",
    marketplaceId: "EBAY_US",
    connectionGeneration,
    fulfillmentPolicy: choice,
    paymentPolicy: choice,
    returnPolicy: choice,
    inventoryLocation: choice,
    discoveredAt: "2026-07-27T12:00:00.000Z",
  };
}

function selectionRequiredBinding(
  connectionGeneration: string,
): EbayPolicyLocationBinding {
  return {
    ...readyBinding("unresolved", connectionGeneration),
    state: "selectionRequired",
    fulfillmentPolicy: {
      state: "selectionRequired",
      selectedId: null,
      candidates: [
        {
          id: "unresolved-fulfillment-a",
          label: "First shipping policy",
          providerDefault: false,
        },
        {
          id: "unresolved-fulfillment-b",
          label: "Second shipping policy",
          providerDefault: false,
        },
      ],
    },
  };
}

async function connectAndBind(
  server: SupabaseClient,
  prefix: string,
  ebayUserId: string,
): Promise<void> {
  await saveEbayConnection(
    server,
    {
      accessToken: `${prefix}-access-token`,
      refreshToken: `${prefix}-refresh-token`,
      accessTokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
      scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
    },
    { userId: ebayUserId, username: `${prefix}-seller` },
    TEST_ENV,
  );
  const store = createSupabaseEbayPolicyLocationBindingStore(server);
  const context = await store.readConnectionContext();
  if (!context) throw new Error(`Missing ${prefix} eBay connection`);
  await store.saveBinding(readyBinding(prefix, context.connectionGeneration));
}

async function uploadPhoto(user: ClerkTestUser): Promise<string> {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const path = `${user.id}/${randomBytes(8).toString("hex")}-publish.png`;
  const { error } = await user.client.storage
    .from("photos")
    .upload(path, bytes, { contentType: "image/png" });
  if (error) throw new Error(`Photo upload failed: ${error.message}`);
  uploadedPhotos.push(path);
  return path;
}

async function persistedListing(user: ClerkTestUser): Promise<string> {
  const photo = await uploadPhoto(user);
  const { listingId } = await runPipelineAndPersist(
    user.client,
    { userId: user.id, photos: [photo] },
    new StubPipeline(),
  );
  return listingId;
}

function fakeEbayFetch(
  prefix: string,
  beforePublishResponse?: () => Promise<void>,
): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/inventory_item/")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/sell/inventory/v1/offer")) {
      return Response.json({ offerId: `${prefix}-offer` }, { status: 201 });
    }
    if (url.endsWith(`/offer/${prefix}-offer/publish`)) {
      await beforePublishResponse?.();
      return Response.json({ listingId: `${prefix}-listing` });
    }
    throw new Error(`Unexpected fake eBay call: ${url}`);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function failingEbayFetch(
  response: "ambiguous" | "rejected",
): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    calls.push({ url: String(input), init });
    if (response === "ambiguous") {
      throw new Error("Fake eBay connection ended without acknowledgement");
    }
    return Response.json(
      { errors: [{ errorId: 25001, message: "Rejected fixture write" }] },
      { status: 400 },
    );
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function offerBody(calls: RecordedCall[]): Record<string, unknown> {
  const call = calls.find(
    ({ url, init }) =>
      url.endsWith("/sell/inventory/v1/offer") && init.method === "POST",
  );
  if (!call) throw new Error("Fake eBay offer call was not recorded");
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

async function rotateConnectionGeneration(userId: string): Promise<void> {
  const before = await admin
    .from("ebay_connections")
    .select("refresh_token_enc, connection_generation")
    .eq("user_id", userId)
    .single();
  if (before.error || !before.data) {
    throw new Error(`Failed to read connection-generation fixture: ${before.error?.message}`);
  }
  const { error } = await admin
    .from("ebay_connections")
    .update({
      refresh_token_enc:
        `${before.data.refresh_token_enc}.rotated-${randomBytes(4).toString("hex")}`,
    })
    .eq("user_id", userId);
  if (error) {
    throw new Error(`Failed to rotate connection-generation fixture: ${error.message}`);
  }
  const after = await admin
    .from("ebay_connections")
    .select("connection_generation")
    .eq("user_id", userId)
    .single();
  if (
    after.error
    || !after.data
    || after.data.connection_generation === before.data.connection_generation
  ) {
    throw new Error("Connection-generation fixture did not rotate");
  }
}

async function cleanPrivateIdentityRows(): Promise<void> {
  const userIds = [userA.id, userB.id];
  const database = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });
  await database.connect();
  try {
    await database.query("begin");
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
    await database.query("commit");
  } catch (error) {
    await database.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await database.end();
  }
}

beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: PUBLISHABLE_KEY, requiredValues: [PUBLISHABLE_KEY?.startsWith("sb_publishable_"), SECRET_KEY?.startsWith("sb_secret_"), ["127.0.0.1", "localhost", "::1"].includes(new URL(SUPABASE_URL).hostname)] });
  await whenStackReachable(reachable, async () => {
  lease = await acquireExclusiveTestResource(
    `local-db:ebay-publish-connection-binding:${SUPABASE_URL}`,
  );
  admin = createClient(SUPABASE_URL, SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, PUBLISHABLE_KEY!, "publish_binding_a"),
    provisionClerkTestUser(SUPABASE_URL, PUBLISHABLE_KEY!, "publish_binding_b"),
  ]);
  [serverA, serverB] = await Promise.all([
    tenantServerClient(userA.id),
    tenantServerClient(userB.id),
  ]);
  const suffix = randomBytes(8).toString("hex");
  ebayIdentityA = {
    userId: `EBAYUID-PUBLISH-A-${suffix}`,
    username: `seller-a-${suffix}`,
  };
  ebayIdentityB = {
    userId: `EBAYUID-PUBLISH-B-${suffix}`,
    username: `seller-b-${suffix}`,
  };
  await Promise.all([
    connectAndBind(serverA, "seller-a", ebayIdentityA.userId),
    connectAndBind(serverB, "seller-b", ebayIdentityB.userId),
  ]);

  });}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await whenStackReachable(reachable, async () => {
  try {
    if (admin && uploadedPhotos.length > 0) {
      await admin.storage.from("photos").remove(uploadedPhotos);
    }
    if (admin && userA && userB) {
      await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
      await cleanPrivateIdentityRows();
    }
  } finally {
    await lease?.release();
  }

  });}, TEST_TIMEOUT_MS);

describe("connection-generation eBay publish boundary (DB-gated, offline)", () => {
  it("builds each tenant offer only from that seller's ready EBAY_US binding", async () => {

    const [listingA, listingB] = await Promise.all([
      persistedListing(userA),
      persistedListing(userB),
    ]);
    const fakeA = fakeEbayFetch("seller-a");
    const fakeB = fakeEbayFetch("seller-b");
    const noTokenEgress = async () => {
      throw new Error("Cached seller token should prevent OAuth egress");
    };
    const adapterA = new HttpEbayAdapter({
      fetch: fakeA.fetch,
      tokenProvider: new UserTokenProvider(serverA, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });
    const adapterB = new HttpEbayAdapter({
      fetch: fakeB.fetch,
      tokenProvider: new UserTokenProvider(serverB, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });

    const [publishedA, publishedB] = await Promise.all([
      publishListingToEbay(userA.client, listingA, adapterA, {
        completionClient: serverA,
      }),
      publishListingToEbay(userB.client, listingB, adapterB, {
        completionClient: serverB,
      }),
    ]);

    expect(publishedA.ebayListingId).toBe("seller-a-listing");
    expect(publishedB.ebayListingId).toBe("seller-b-listing");
    expect(fakeA.calls).toHaveLength(3);
    expect(fakeB.calls).toHaveLength(3);
    expect(offerBody(fakeA.calls)).toMatchObject({
      listingPolicies: {
        fulfillmentPolicyId: "seller-a-fulfillment",
        paymentPolicyId: "seller-a-payment",
        returnPolicyId: "seller-a-return",
      },
      merchantLocationKey: "seller-a-location",
    });
    expect(offerBody(fakeB.calls)).toMatchObject({
      listingPolicies: {
        fulfillmentPolicyId: "seller-b-fulfillment",
        paymentPolicyId: "seller-b-payment",
        returnPolicyId: "seller-b-return",
      },
      merchantLocationKey: "seller-b-location",
    });
    expect(JSON.stringify(offerBody(fakeA.calls))).not.toContain("seller-b");
    expect(JSON.stringify(offerBody(fakeB.calls))).not.toContain("seller-a");
  }, TEST_TIMEOUT_MS);

  it("performs zero eBay writes for missing, stale, foreign, cross-marketplace, or unresolved bindings", async () => {

    const storeA = createSupabaseEbayPolicyLocationBindingStore(serverA);
    const storeB = createSupabaseEbayPolicyLocationBindingStore(serverB);
    const [contextA, contextB] = await Promise.all([
      storeA.readConnectionContext(),
      storeB.readConnectionContext(),
    ]);
    if (!contextA || !contextB) throw new Error("Test connections are required");

    const cases: Array<{
      name: string;
      bindings: Record<string, EbayPolicyLocationBinding>;
    }> = [
      { name: "missing", bindings: {} },
      {
        name: "stale",
        bindings: {
          EBAY_US: readyBinding(
            "stale",
            "11111111-1111-4111-8111-111111111111",
          ),
        },
      },
      {
        name: "foreign",
        bindings: {
          EBAY_US: readyBinding("seller-b", contextB.connectionGeneration),
        },
      },
      {
        name: "cross-marketplace",
        bindings: {
          EBAY_GB: {
            ...readyBinding("seller-a-gb", contextA.connectionGeneration),
            marketplaceId: "EBAY_GB",
          },
        },
      },
      {
        name: "setup-required",
        bindings: {
          EBAY_US: setupRequiredBinding(contextA.connectionGeneration),
        },
      },
      {
        name: "selection-required",
        bindings: {
          EBAY_US: selectionRequiredBinding(contextA.connectionGeneration),
        },
      },
    ];

    for (const fixture of cases) {
      const { error } = await admin
        .from("ebay_connections")
        .update({ policy_location_bindings: fixture.bindings })
        .eq("user_id", userA.id);
      expect(error, fixture.name).toBeNull();
      const listingId = await persistedListing(userA);
      const fake = fakeEbayFetch(fixture.name);
      const adapter = new HttpEbayAdapter({
        fetch: fake.fetch,
        tokenProvider: new UserTokenProvider(serverA, {
          fetch: async () => {
            throw new Error("Rejected setup must not reach OAuth");
          },
          env: () => TEST_ENV,
        }),
        env: () => SHARED_ENV_FALLBACK,
      });

      const result = await publishListingToEbay(
        userA.client,
        listingId,
        adapter,
        {
          completionClient: serverA,
        },
      ).catch((error: unknown) => error);
      const { data: listing } = await userA.client
        .from("listings")
        .select("ebay_status, ebay_listing_id")
        .eq("id", listingId)
        .single();
      expect.soft(fake.calls, fixture.name).toHaveLength(0);
      expect.soft(listing, fixture.name).toMatchObject({
        ebay_status: null,
        ebay_listing_id: null,
      });
      expect(result, fixture.name).toBeInstanceOf(Error);
      expect((result as Error).message, fixture.name).toMatch(
        /policy.location setup|finish policy.location/i,
      );
    }

    await storeA.saveBinding(
      readyBinding("seller-a", contextA.connectionGeneration),
    );
  }, TEST_TIMEOUT_MS);

  it("fences reconnect, completion, and replay to one connection generation", async () => {

    const noTokenEgress = async () => {
      throw new Error("Cached seller token should prevent OAuth egress");
    };
    const storeA = createSupabaseEbayPolicyLocationBindingStore(serverA);
    const storeB = createSupabaseEbayPolicyLocationBindingStore(serverB);
    const [contextA, contextB] = await Promise.all([
      storeA.readConnectionContext(),
      storeB.readConnectionContext(),
    ]);
    if (!contextA || !contextB) throw new Error("Test connections are required");

    // Same-generation stored-result replay is exactly once.
    const replayListingId = await persistedListing(userB);
    const replayFake = fakeEbayFetch("same-generation");
    const replayAdapter = new HttpEbayAdapter({
      fetch: replayFake.fetch,
      tokenProvider: new UserTokenProvider(serverB, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });
    const firstReplay = await publishListingToEbay(
      userB.client,
      replayListingId,
      replayAdapter,
      { completionClient: serverB },
    );
    expect(firstReplay.alreadyPublished).toBe(false);
    for (const fixture of [
      { name: "missing", bindings: {} },
      {
        name: "setup-required",
        bindings: {
          EBAY_US: setupRequiredBinding(contextB.connectionGeneration),
        },
      },
      {
        name: "selection-required",
        bindings: {
          EBAY_US: selectionRequiredBinding(contextB.connectionGeneration),
        },
      },
    ]) {
      const { error } = await admin
        .from("ebay_connections")
        .update({ policy_location_bindings: fixture.bindings })
        .eq("user_id", userB.id);
      expect(error, fixture.name).toBeNull();
      const sameGenerationReplay = await publishListingToEbay(
        userB.client,
        replayListingId,
        replayAdapter,
        { completionClient: serverB },
      );
      expect(sameGenerationReplay.alreadyPublished, fixture.name).toBe(true);
      expect(replayFake.calls, fixture.name).toHaveLength(3);
    }
    await storeB.saveBinding(
      readyBinding("seller-b", contextB.connectionGeneration),
    );

    // A policy/location reselection inside the same connection generation is
    // fenced after preflight and before the real dispatch RPC.
    const preDispatchBindingListingId = await persistedListing(userA);
    const preDispatchBindingFake = fakeEbayFetch("pre-dispatch-binding-change");
    const preDispatchBindingAdapter = new HttpEbayAdapter({
      fetch: preDispatchBindingFake.fetch,
      tokenProvider: new UserTokenProvider(serverA, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });
    const bindingDispatch = preDispatchBindingAdapter.publishListing.bind(
      preDispatchBindingAdapter,
    );
    preDispatchBindingAdapter.publishListing = async (request, complete) => {
      await storeA.saveBinding(
        readyBinding("seller-a-reselected", contextA.connectionGeneration),
      );
      return bindingDispatch(request, complete);
    };
    const preDispatchBindingResult = await publishListingToEbay(
      userA.client,
      preDispatchBindingListingId,
      preDispatchBindingAdapter,
      { completionClient: serverA },
    ).catch((error: unknown) => error);
    const preDispatchBindingRow = await userA.client
      .from("listings")
      .select("ebay_status, ebay_listing_id")
      .eq("id", preDispatchBindingListingId)
      .single();
    expect.soft(
      preDispatchBindingFake.calls,
      "pre-dispatch binding change",
    ).toHaveLength(0);
    expect.soft(
      preDispatchBindingResult,
      "pre-dispatch binding change",
    ).toBeInstanceOf(Error);
    expect.soft(
      preDispatchBindingRow.data,
      "pre-dispatch binding change",
    ).not.toMatchObject({
      ebay_status: "published",
    });
    await storeA.saveBinding(
      readyBinding("seller-a", contextA.connectionGeneration),
    );

    // Once dispatch admission pins the exact tuple, a same-marketplace
    // reselection is rejected before token access or any provider write. The
    // same save remains available after the lease is released.
    const activeLeaseListingId = await persistedListing(userA);
    const activeLeaseFake = fakeEbayFetch("active-lease-binding-change");
    const activeLeaseProvider = new UserTokenProvider(serverA, {
      fetch: noTokenEgress as typeof fetch,
      env: () => TEST_ENV,
    });
    activeLeaseProvider.getAccessToken = async () => {
      await storeA.saveBinding(
        readyBinding("seller-a-during-lease", contextA.connectionGeneration),
      );
      throw new Error("Active-lease binding mutation unexpectedly succeeded");
    };
    const activeLeaseAdapter = new HttpEbayAdapter({
      fetch: activeLeaseFake.fetch,
      tokenProvider: activeLeaseProvider,
      env: () => SHARED_ENV_FALLBACK,
    });
    const activeLeaseResult = await publishListingToEbay(
      userA.client,
      activeLeaseListingId,
      activeLeaseAdapter,
      { completionClient: serverA },
    ).catch((error: unknown) => error);
    const activeLeaseRow = await userA.client
      .from("listings")
      .select("ebay_status, ebay_listing_id")
      .eq("id", activeLeaseListingId)
      .single();
    expect.soft(activeLeaseFake.calls, "active publish lease").toHaveLength(0);
    expect.soft(activeLeaseResult, "active publish lease").toBeInstanceOf(Error);
    expect.soft(
      (activeLeaseResult as Error).message,
      "active publish lease",
    ).toMatch(/active publish dispatch/i);
    expect.soft(activeLeaseRow.data, "active publish lease").not.toMatchObject({
      ebay_status: "published",
    });
    await storeA.saveBinding(
      readyBinding("seller-a-after-lease", contextA.connectionGeneration),
    );
    await storeA.saveBinding(
      readyBinding("seller-a", contextA.connectionGeneration),
    );

    // Reconnect after binding preflight but before the real dispatch RPC.
    const preDispatchListingId = await persistedListing(userA);
    const preDispatchFake = fakeEbayFetch("pre-dispatch-reconnect");
    const preDispatchAdapter = new HttpEbayAdapter({
      fetch: preDispatchFake.fetch,
      tokenProvider: new UserTokenProvider(serverA, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });
    const dispatch = preDispatchAdapter.publishListing.bind(preDispatchAdapter);
    preDispatchAdapter.publishListing = async (request, complete) => {
      await saveEbayConnection(
        serverA,
        {
          accessToken: "seller-a-reconnected-access-token",
          refreshToken: "seller-a-reconnected-refresh-token",
          accessTokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
          scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
        },
        ebayIdentityA,
        TEST_ENV,
      );
      return dispatch(request, complete);
    };
    const preDispatchResult = await publishListingToEbay(
      userA.client,
      preDispatchListingId,
      preDispatchAdapter,
      { completionClient: serverA },
    ).catch((error: unknown) => error);
    const preDispatchRow = await userA.client
      .from("listings")
      .select("ebay_status, ebay_listing_id")
      .eq("id", preDispatchListingId)
      .single();
    expect.soft(preDispatchFake.calls, "pre-dispatch reconnect").toHaveLength(0);
    expect.soft(preDispatchResult, "pre-dispatch reconnect").toBeInstanceOf(Error);
    expect.soft(preDispatchRow.data, "pre-dispatch reconnect").not.toMatchObject({
      ebay_status: "published",
    });

    const currentContextA = await storeA.readConnectionContext();
    if (!currentContextA) {
      throw new Error("Reconnected seller A context is required");
    }
    await storeA.saveBinding(
      readyBinding("seller-a-current", currentContextA.connectionGeneration),
    );

    // A definite provider rejection clears both connected-seller provenance
    // fields, so a later exact null-generation operator fallback is not wedged
    // by half-cleared state.
    const rejectedListingId = await persistedListing(userA);
    const rejectedFake = failingEbayFetch("rejected");
    const rejectedAdapter = new HttpEbayAdapter({
      fetch: rejectedFake.fetch,
      tokenProvider: new UserTokenProvider(serverA, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });
    const rejectedResult = await publishListingToEbay(
      userA.client,
      rejectedListingId,
      rejectedAdapter,
      { completionClient: serverA },
    ).catch((error: unknown) => error);
    const rejectedRow = await userA.client
      .from("listings")
      .select(
        "ebay_status, ebay_listing_id, ebay_publish_connection_generation, ebay_publish_binding",
      )
      .eq("id", rejectedListingId)
      .single();
    expect.soft(rejectedFake.calls, "definite provider rejection").toHaveLength(1);
    expect.soft(rejectedResult, "definite provider rejection").toBeInstanceOf(Error);
    expect.soft(rejectedRow.data, "definite provider rejection").toMatchObject({
      ebay_status: "failed",
      ebay_listing_id: null,
      ebay_publish_connection_generation: null,
      ebay_publish_binding: null,
    });

    // A provider-may-have-committed write retains the original generation and
    // tuple. Even after claim expiry and reconnect, the replacement generation
    // cannot erase that provenance or reach eBay again.
    const ambiguousListingId = await persistedListing(userA);
    const ambiguousFake = failingEbayFetch("ambiguous");
    const ambiguousAdapter = new HttpEbayAdapter({
      fetch: ambiguousFake.fetch,
      tokenProvider: new UserTokenProvider(serverA, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });
    const ambiguousResult = await publishListingToEbay(
      userA.client,
      ambiguousListingId,
      ambiguousAdapter,
      { completionClient: serverA },
    ).catch((error: unknown) => error);
    const ambiguousPinnedRow = await userA.client
      .from("listings")
      .select(
        "ebay_status, ebay_publish_claim_id, ebay_publish_connection_generation, ebay_publish_binding",
      )
      .eq("id", ambiguousListingId)
      .single();
    expect.soft(ambiguousFake.calls, "ambiguous provider write").toHaveLength(1);
    expect.soft(ambiguousResult, "ambiguous provider write").toBeInstanceOf(Error);
    expect.soft(ambiguousPinnedRow.data, "ambiguous provider write").toMatchObject({
      ebay_status: "publishing",
      ebay_publish_connection_generation: currentContextA.connectionGeneration,
    });
    expect(
      ambiguousPinnedRow.data?.ebay_publish_claim_id,
      "ambiguous provider write",
    ).toBeTruthy();
    expect(
      ambiguousPinnedRow.data?.ebay_publish_binding,
      "ambiguous provider write",
    ).toBeTruthy();

    const { error: expireClaimError } = await admin
      .from("listings")
      .update({
        ebay_publish_claimed_at: "2026-07-27T00:00:00.000Z",
      })
      .eq("id", ambiguousListingId);
    expect(expireClaimError).toBeNull();
    await saveEbayConnection(
      serverA,
      {
        accessToken: "seller-a-ambiguous-reconnect-access-token",
        refreshToken: "seller-a-ambiguous-reconnect-refresh-token",
        accessTokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
        scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
      },
      ebayIdentityA,
      TEST_ENV,
    );
    const replacementContextA = await storeA.readConnectionContext();
    if (!replacementContextA) {
      throw new Error("Replacement seller A context is required");
    }
    await storeA.saveBinding(
      readyBinding(
        "seller-a-ambiguous-replacement",
        replacementContextA.connectionGeneration,
      ),
    );
    const ambiguousRetryFake = fakeEbayFetch("ambiguous-retry");
    const ambiguousRetryAdapter = new HttpEbayAdapter({
      fetch: ambiguousRetryFake.fetch,
      tokenProvider: new UserTokenProvider(serverA, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });
    const ambiguousRetryResult = await publishListingToEbay(
      userA.client,
      ambiguousListingId,
      ambiguousRetryAdapter,
      { completionClient: serverA },
    ).catch((error: unknown) => error);
    const ambiguousRetryRow = await userA.client
      .from("listings")
      .select(
        "ebay_status, ebay_listing_id, ebay_publish_connection_generation, ebay_publish_binding",
      )
      .eq("id", ambiguousListingId)
      .single();
    expect.soft(
      ambiguousRetryFake.calls,
      "changed-generation ambiguous retry",
    ).toHaveLength(0);
    expect.soft(
      ambiguousRetryResult,
      "changed-generation ambiguous retry",
    ).toBeInstanceOf(Error);
    expect.soft(
      ambiguousRetryRow.data,
      "changed-generation ambiguous retry",
    ).toMatchObject({
      ebay_publish_connection_generation: currentContextA.connectionGeneration,
      ebay_publish_binding: ambiguousPinnedRow.data?.ebay_publish_binding,
    });
    expect.soft(
      ambiguousRetryRow.data,
      "changed-generation ambiguous retry",
    ).not.toMatchObject({
      ebay_status: "published",
    });

    // Rotate after fake provider acknowledgement but before durable completion.
    const completionListingId = await persistedListing(userB);
    const completionFake = fakeEbayFetch(
      "completion-reconnect",
      () => rotateConnectionGeneration(userB.id),
    );
    const completionAdapter = new HttpEbayAdapter({
      fetch: completionFake.fetch,
      tokenProvider: new UserTokenProvider(serverB, {
        fetch: noTokenEgress as typeof fetch,
        env: () => TEST_ENV,
      }),
      env: () => SHARED_ENV_FALLBACK,
    });
    const completionResult = await publishListingToEbay(
      userB.client,
      completionListingId,
      completionAdapter,
      { completionClient: serverB },
    ).catch((error: unknown) => error);
    const completionRetry = await publishListingToEbay(
      userB.client,
      completionListingId,
      completionAdapter,
      { completionClient: serverB },
    ).catch((error: unknown) => error);
    const changedGenerationReplay = await publishListingToEbay(
      userB.client,
      replayListingId,
      replayAdapter,
      { completionClient: serverB },
    ).catch((error: unknown) => error);
    const completionRow = await userB.client
      .from("listings")
      .select("ebay_status, ebay_listing_id")
      .eq("id", completionListingId)
      .single();

    expect(completionFake.calls).toHaveLength(3);
    expect.soft(completionResult, "changed-generation completion").toBeInstanceOf(
      Error,
    );
    expect.soft(completionRetry, "changed-generation retry").toBeInstanceOf(Error);
    expect.soft(
      changedGenerationReplay,
      "changed-generation stored replay",
    ).toBeInstanceOf(Error);
    expect.soft(completionRow.data, "changed-generation completion").not.toMatchObject({
      ebay_status: "published",
    });
    expect(replayFake.calls).toHaveLength(3);
  }, TEST_TIMEOUT_MS);
});
