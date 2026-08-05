import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "../../supabase/test-users";
import { StubPipeline } from "../../pipeline/stub";
import { runPipelineAndPersist } from "../../pipeline/persist";
import { MockEbayAdapter } from "./mock";
import { publishListingToEbay } from "./publish";
import { toEbayCondition } from "./map";
import { saveEbayConnection } from "./connections";
import { createSupabaseEbayPolicyLocationBindingStore } from "./policy-location-store";
import type { EbayPolicyLocationBinding } from "./policy-location-contract";
import { serverRpcHeaders } from "@/lib/supabase/server-rpc-auth";

/**
 * eBay publish seam test (issue #14): persisted listing -> adapter ->
 * ebay_listing_id + ebay_status written back, all under RLS against the running
 * local Postgres. Uses the OFFLINE MockEbayAdapter exclusively — NO live eBay
 * call (the acceptance criterion); the HTTP adapter has its own fake-fetch
 * contract tests (http.test.ts).
 *
 * Follows persist.test.ts: ephemeral confirmed users via the service role, each
 * acting through its OWN anon client so RLS sees a real session; cleaned up in
 * afterAll. Skips (never fakes a pass) if the stack is unreachable.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVER_RPC_SECRET = process.env.SERVER_RPC_SECRET;
const CONNECTION_ENV = {
  EBAY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

let reachable = false;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;
let serverA: SupabaseClient;
let serverB: SupabaseClient;

// Clerk-era provisioning (issue #41): identities are minted JWTs with text
// subs — no auth.users rows. See test-users.ts.
async function provisionUser(label: string): Promise<ClerkTestUser> {
  return provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, `publish_${label}`);
}

async function tenantServerClient(userId: string): Promise<SupabaseClient> {
  const token = await mintUserJwt(userId);
  return createClient(SUPABASE_URL, SECRET_KEY!, {
    accessToken: async () => token,
    global: { headers: serverRpcHeaders(SERVER_RPC_SECRET!) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function readyBinding(
  marketplaceId: string,
  connectionGeneration: string,
): EbayPolicyLocationBinding {
  const choice = (kind: string) => ({
    state: "bound" as const,
    selectedId: `${marketplaceId}-${kind}`,
    candidates: [{
      id: `${marketplaceId}-${kind}`,
      label: `${marketplaceId} ${kind}`,
      providerDefault: false,
    }],
  });
  return {
    state: "ready",
    marketplaceId,
    connectionGeneration,
    fulfillmentPolicy: choice("fulfillment"),
    paymentPolicy: choice("payment"),
    returnPolicy: choice("return"),
    inventoryLocation: choice("location"),
    discoveredAt: "2026-07-27T12:00:00.000Z",
  };
}

async function connectAndBind(
  server: SupabaseClient,
  seller: string,
  marketplaces: string[],
): Promise<void> {
  await saveEbayConnection(
    server,
    {
      accessToken: `${seller}-access`,
      refreshToken: `${seller}-refresh`,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
    },
    { userId: `${seller}-id`, username: seller },
    CONNECTION_ENV,
  );
  const store = createSupabaseEbayPolicyLocationBindingStore(server);
  const context = await store.readConnectionContext();
  if (!context) throw new Error("eBay connection fixture was not created");
  for (const marketplaceId of marketplaces) {
    await store.saveBinding(
      readyBinding(marketplaceId, context.connectionGeneration),
    );
  }
}

/** Upload a tiny PNG to the user-scoped path, as the upload route would. */
async function uploadPhoto(user: ClerkTestUser): Promise<string> {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const bytes = Buffer.from(pngBase64, "base64");
  const path = `${user.id}/${Date.now()}-ebay-pub.png`;
  const { error } = await user.client.storage
    .from("photos")
    .upload(path, bytes, { contentType: "image/png", upsert: true });
  if (error) throw new Error(`upload failed: ${error.message}`);
  return path;
}

/** Run the stub pipeline end-to-end so a real listings row + price log exist. */
async function persistedRun(user: ClerkTestUser) {
  const photoPath = await uploadPhoto(user);
  return runPipelineAndPersist(
    user.client,
    { userId: user.id, photos: [photoPath] },
    new StubPipeline(),
  );
}

beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: ANON_KEY, requiredValues: [ANON_KEY, SECRET_KEY, SERVER_RPC_SECRET] });
  await whenStackReachable(reachable, async () => {
  admin = createClient(SUPABASE_URL, SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([provisionUser("a"), provisionUser("b")]);
  [serverA, serverB] = await Promise.all([
    tenantServerClient(userA.id),
    tenantServerClient(userB.id),
  ]);
  await Promise.all([
    connectAndBind(serverA, "publish-a", ["EBAY_US", "EBAY_GB"]),
    connectAndBind(serverB, "publish-b", ["EBAY_US"]),
  ]);

  });
});

afterAll(async () => {
  if (!reachable || !admin) return;
  // No auth.users cascade anymore (Clerk migration dropped those FKs) —
  // delete owned domain rows explicitly.
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("publishListingToEbay (mock adapter, offline; persisted under RLS)", () => {
  it("requires a running local Supabase stack (skips otherwise, never fakes a pass)", () => {
    if (!reachable) {
      console.warn(
        "[ebay publish.test] Local Supabase stack unreachable — skipping. " +
          "Get keys with `pnpm supabase status -o env` and map them into the env.",
      );
    }
    expect(true).toBe(true);
  });

  it("publishes via the adapter and persists ebay_listing_id + ebay_status on the row", async () => {


    const { listingId, result } = await persistedRun(userA);
    const adapter = new MockEbayAdapter();
    adapter.publishListing = async (request, complete) => {
      adapter.requests.push(request);
      const publishResult = {
        listingId: `MOCK-EBAY-LISTING-${request.sku}`,
        offerId: `MOCK-EBAY-OFFER-${request.sku}`,
        listingUrl: `https://www.ebay.com/itm/MOCK-EBAY-LISTING-${request.sku}`,
        status: "published" as const,
      };
      await complete?.(publishResult, null);
      return publishResult;
    };

    const outcome = await publishListingToEbay(serverA, listingId, adapter);

    expect(outcome).toEqual({
      listingId,
      ebayListingId: `MOCK-EBAY-LISTING-${listingId}`,
      ebayOfferId: `MOCK-EBAY-OFFER-${listingId}`,
      listingUrl: `https://www.ebay.com/itm/MOCK-EBAY-LISTING-${listingId}`,
      ebayStatus: "published",
      alreadyPublished: false,
    });

    // The adapter saw EXACTLY the persisted run's listing, price, and condition.
    expect(adapter.requests).toHaveLength(1);
    const sent = adapter.requests[0]!;
    expect(sent.sku).toBe(listingId);
    expect(sent.title).toBe(result.listing.title);
    expect(sent.description).toBe(result.listing.description);
    expect(sent.price).toEqual({
      value: result.price.suggested.toFixed(2),
      currency: "USD",
    });
    expect(sent.condition).toBe(toEbayCondition(result.attributes.condition));
    expect(sent.quantity).toBe(1);
    // The private photo was signed into a fetchable URL for eBay.
    expect(sent.imageUrls.length).toBeGreaterThan(0);
    expect(sent.imageUrls[0]).toContain("/photos/");

    // Persisted state, read back AS THE OWNER (the acceptance seam).
    const { data: row } = await userA.client
      .from("listings")
      .select("status, ebay_listing_id, ebay_offer_id, ebay_status")
      .eq("id", listingId)
      .single();
    expect(row?.ebay_listing_id).toBe(`MOCK-EBAY-LISTING-${listingId}`);
    expect(row?.ebay_offer_id).toBe(`MOCK-EBAY-OFFER-${listingId}`);
    expect(row?.ebay_status).toBe("published");
    expect(row?.status).toBe("published");
  });

  it("rejects publishing to a non-USD marketplace instead of relabeling the USD price", async () => {


    const { listingId } = await persistedRun(userA);
    const adapter = new MockEbayAdapter();

    // Prices come from the USD pricing pipeline; 100 (USD) published as 100 GBP
    // would misprice the live listing — so EBAY_GB without an explicit currency
    // declaration must refuse BEFORE any eBay call.
    await expect(
      publishListingToEbay(serverA, listingId, adapter, {
        env: () => ({ EBAY_MARKETPLACE_ID: "EBAY_GB" }),
      }),
    ).rejects.toThrowError(/relabeling|computed in USD/i);
    expect(adapter.requests).toHaveLength(0);

    // An explicit EBAY_CURRENCY is the operator's declaration that persisted
    // prices ARE in that currency — then the publish proceeds with it.
    const declared = await publishListingToEbay(serverA, listingId, adapter, {
      env: () => ({ EBAY_MARKETPLACE_ID: "EBAY_GB", EBAY_CURRENCY: "GBP" }),
    });
    expect(declared.ebayStatus).toBe("published");
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.price.currency).toBe("GBP");
  });

  it("is idempotent: an already-published listing returns the stored result without another eBay call", async () => {


    const { listingId } = await persistedRun(userA);
    const adapter = new MockEbayAdapter();

    const first = await publishListingToEbay(serverA, listingId, adapter);
    const second = await publishListingToEbay(serverA, listingId, adapter);

    expect(adapter.requests).toHaveLength(1); // no second adapter call
    expect(second.alreadyPublished).toBe(true);
    expect(second.ebayListingId).toBe(first.ebayListingId);
  });

  it("persists ebay_status='failed' (and rethrows) when the adapter fails — local status untouched", async () => {


    const { listingId } = await persistedRun(userA);
    const adapter = new MockEbayAdapter();
    adapter.failWith = new Error("eBay sandbox rejected the offer");

    await expect(
      publishListingToEbay(serverA, listingId, adapter),
    ).rejects.toThrowError(/sandbox rejected/);

    const { data: row } = await userA.client
      .from("listings")
      .select("status, ebay_listing_id, ebay_status")
      .eq("id", listingId)
      .single();
    expect(row?.ebay_status).toBe("failed");
    // The eBay failure lives in ebay_status ONLY — the local lifecycle keeps
    // the listing visible to review/draft flows.
    expect(row?.status).toBe("draft");
    expect(row?.ebay_listing_id).toBeNull();

    // The failed publish is RETRYABLE: clearing the failure publishes cleanly.
    adapter.failWith = undefined;
    const retried = await publishListingToEbay(serverA, listingId, adapter);
    expect(retried.ebayStatus).toBe("published");
    const { data: after } = await userA.client
      .from("listings")
      .select("ebay_status, ebay_listing_id")
      .eq("id", listingId)
      .single();
    expect(after?.ebay_status).toBe("published");
    expect(after?.ebay_listing_id).toBe(retried.ebayListingId);
  });

  it("does not mark an acknowledged publish failed when generation-bound completion rejects", async () => {


    const { listingId } = await persistedRun(userA);
    const adapter = new MockEbayAdapter();
    adapter.publishListing = async (request, complete) => {
      adapter.requests.push(request);
      const result = {
        listingId: `ACKNOWLEDGED-${request.sku}`,
        offerId: `ACKNOWLEDGED-OFFER-${request.sku}`,
        status: "published" as const,
      };
      await complete?.(result, {
        accountGeneration: "55555555-5555-4555-8555-555555555555",
        connectionGeneration: request.connectionGeneration,
        publishClaimId: request.publishClaimId,
        attemptToken: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      });
      return result;
    };
    const completionClient = {
      rpc: async (name: string, params?: Record<string, unknown>) => {
        if (name === "complete_ebay_publish_dispatch") {
          return { data: null, error: { message: "generation changed" } };
        }
        return serverA.rpc(name, params);
      },
    } as unknown as SupabaseClient;

    await expect(
      publishListingToEbay(serverA, listingId, adapter, {
        completionClient,
      }),
    ).rejects.toThrow(/generation-bound persistence failed/i);

    const { data: row } = await userA.client
      .from("listings")
      .select("ebay_status, ebay_publish_claim_id")
      .eq("id", listingId)
      .single();
    expect(row?.ebay_status).toBe("publishing");
    expect(row?.ebay_publish_claim_id).not.toBeNull();
  });

  it("RLS holds: user B cannot publish user A's listing (indistinguishable from missing)", async () => {


    const { listingId } = await persistedRun(userA);
    const adapter = new MockEbayAdapter();

    await expect(
      publishListingToEbay(serverB, listingId, adapter),
    ).rejects.toThrowError(/not found/i);
    expect(adapter.requests).toHaveLength(0);

    // And A's row was NOT marked failed by B's attempt.
    const { data: row } = await userA.client
      .from("listings")
      .select("ebay_status")
      .eq("id", listingId)
      .single();
    expect(row?.ebay_status).toBeNull();
  });

  it("refuses to publish a non-eBay listing", async () => {


    const { itemId } = await persistedRun(userA);
    const { data: fb, error } = await userA.client
      .from("listings")
      .insert({
        user_id: userA.id,
        item_id: itemId,
        platform: "facebook",
        title: "FB draft",
        description: "desc",
        copy: {},
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    const adapter = new MockEbayAdapter();
    await expect(
      publishListingToEbay(serverA, fb!.id as string, adapter),
    ).rejects.toThrowError(/not eBay/);
    expect(adapter.requests).toHaveLength(0);
  });

  it("fails fast and marks the listing failed when the item has NO photos (no eBay call)", async () => {


    // Hand-built item with an empty photos array, plus a price log so the
    // image check is the ONLY thing standing between us and the adapter.
    const { data: item } = await userA.client
      .from("items")
      .insert({ user_id: userA.id, photos: [], attributes: {} })
      .select("id")
      .single();
    const { data: listing } = await userA.client
      .from("listings")
      .insert({
        user_id: userA.id,
        item_id: item!.id as string,
        platform: "ebay",
        title: "Photo-less thing",
        description: "Never photographed.",
        copy: {},
      })
      .select("id")
      .single();
    const { error: logErr } = await userA.client
      .from("prediction_logs")
      .insert({
        user_id: userA.id,
        item_id: item!.id as string,
        price: 25,
        // listing_model is NOT NULL (provenance, #32) — required even for
        // hand-built fixture rows that bypass logPrediction.
        listing_model: "test-fixture",
      });
    expect(logErr).toBeNull();

    const adapter = new MockEbayAdapter();
    await expect(
      publishListingToEbay(serverA, listing!.id as string, adapter),
    ).rejects.toThrowError(/has no photos/i);
    expect(adapter.requests).toHaveLength(0); // never reached eBay

    // Reported through the existing failed-publish path (ebay_status only —
    // the local lifecycle is not destroyed).
    const { data: row } = await userA.client
      .from("listings")
      .select("status, ebay_status, ebay_listing_id")
      .eq("id", listing!.id as string)
      .single();
    expect(row?.ebay_status).toBe("failed");
    expect(row?.status).toBe("draft");
    expect(row?.ebay_listing_id).toBeNull();
  });

  it("fails fast and marks the listing failed when EVERY photo URL fails to sign (no eBay call)", async () => {


    // Photo paths that don't exist in storage — every createSignedUrl fails.
    const { data: item } = await userA.client
      .from("items")
      .insert({
        user_id: userA.id,
        photos: [`${userA.id}/missing-1.png`, `${userA.id}/missing-2.png`],
        attributes: {},
      })
      .select("id")
      .single();
    const { data: listing } = await userA.client
      .from("listings")
      .insert({
        user_id: userA.id,
        item_id: item!.id as string,
        platform: "ebay",
        title: "Unsignable thing",
        description: "Photos vanished from storage.",
        copy: {},
      })
      .select("id")
      .single();
    const { error: logErr } = await userA.client
      .from("prediction_logs")
      .insert({
        user_id: userA.id,
        item_id: item!.id as string,
        price: 25,
        // listing_model is NOT NULL (provenance, #32) — required even for
        // hand-built fixture rows that bypass logPrediction.
        listing_model: "test-fixture",
      });
    expect(logErr).toBeNull();

    const adapter = new MockEbayAdapter();
    await expect(
      publishListingToEbay(serverA, listing!.id as string, adapter),
    ).rejects.toThrowError(/none could be signed/i);
    expect(adapter.requests).toHaveLength(0); // never reached eBay

    const { data: row } = await userA.client
      .from("listings")
      .select("status, ebay_status, ebay_listing_id")
      .eq("id", listing!.id as string)
      .single();
    expect(row?.ebay_status).toBe("failed");
    expect(row?.status).toBe("draft");
    expect(row?.ebay_listing_id).toBeNull();
  });

  it("refuses to publish when no usable price exists for the item", async () => {


    // Hand-built item + listing with NO prediction_logs row (no pipeline run).
    const { data: item } = await userA.client
      .from("items")
      .insert({ user_id: userA.id, photos: [], attributes: {} })
      .select("id")
      .single();
    const { data: listing } = await userA.client
      .from("listings")
      .insert({
        user_id: userA.id,
        item_id: item!.id as string,
        platform: "ebay",
        title: "Priceless thing",
        description: "No price was ever computed.",
        copy: { itemSpecifics: { Brand: "X" } },
      })
      .select("id")
      .single();

    const adapter = new MockEbayAdapter();
    await expect(
      publishListingToEbay(serverA, listing!.id as string, adapter),
    ).rejects.toThrowError(/no usable price/i);
    expect(adapter.requests).toHaveLength(0);
  });

  it("rolls back the publish claim when persisted listing copy is malformed", async () => {


    const { itemId, listingId } = await persistedRun(userA);
    const [{ data: item }, { error: malformedCopyError }] = await Promise.all([
      userA.client.from("items").select("review_revision").eq("id", itemId).single(),
      userA.client.from("listings").update({ copy: [] }).eq("id", listingId),
    ]);
    expect(malformedCopyError).toBeNull();

    const adapter = new MockEbayAdapter();
    await expect(
      publishListingToEbay(serverA, listingId, adapter),
    ).rejects.toThrowError(/listing copy must be an object/i);
    expect(adapter.requests).toHaveLength(0);

    const [{ data: listing }, { data: itemAfter }] = await Promise.all([
      userA.client
        .from("listings")
        .select("status, ebay_status, ebay_publish_claim_id")
        .eq("id", listingId)
        .single(),
      userA.client.from("items").select("review_revision").eq("id", itemId).single(),
    ]);
    expect(listing).toMatchObject({
      status: "draft",
      ebay_status: null,
      ebay_publish_claim_id: null,
    });
    expect(itemAfter?.review_revision).toBe(item?.review_revision);
  });
});
