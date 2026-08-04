import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createMobileApiHandler } from "./app";
import { createMobileEbayPublishService } from "@/lib/marketplace/ebay/mobile-publish";
import {
  EbayWriteAmbiguousError,
  MockEbayAdapter,
  type EbayAdapter,
  type EbayPublishCompletion,
  type EbayPublishRequest,
  type EbayPublishResult,
} from "@/lib/marketplace/ebay";

const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_REVISION = "44444444-4444-4444-8444-444444444444";
const CLAIM_ID = "55555555-5555-4555-8555-555555555555";
const CONNECTION_GENERATION = "66666666-6666-4666-8666-666666666666";
const IDEMPOTENCY_KEY = "77777777-7777-4777-8777-777777777777";

class AmbiguousAfterCompletionAdapter extends MockEbayAdapter {
  override async publishListing(
    request: EbayPublishRequest,
    complete?: EbayPublishCompletion,
  ): Promise<EbayPublishResult> {
    await super.publishListing(request, complete);
    throw new EbayWriteAmbiguousError(
      "Provider response ended after accepting the listing.",
      0,
      null,
    );
  }
}

function publishFixtureClient() {
  const listing = {
    id: LISTING_ID,
    item_id: ITEM_ID,
    platform: "ebay",
    title: "Nintendo Switch OLED",
    description: "Complete console in good condition.",
    copy: { itemSpecifics: { Brand: "Nintendo", Model: "Switch OLED" } },
    status: "draft",
    run_id: RUN_ID,
    ebay_listing_id: null as string | null,
    ebay_offer_id: null as string | null,
    ebay_status: null as string | null,
    ebay_publish_claim_id: null as string | null,
    ebay_publish_connection_generation: null as string | null,
    ebay_publish_binding: null as Record<string, string> | null,
  };
  const item = {
    id: ITEM_ID,
    review_revision: REVIEW_REVISION,
    condition: "like new",
    photos: ["user-1/item-1.jpg"],
    price_override: "177.77",
  };
  const binding = {
    marketplaceId: "EBAY_US",
    connectionGeneration: CONNECTION_GENERATION,
    state: "ready",
    fulfillmentPolicy: {
      state: "bound",
      selectedId: "fulfillment-1",
      candidates: [{ id: "fulfillment-1", label: "Fulfillment", providerDefault: false }],
    },
    paymentPolicy: {
      state: "bound",
      selectedId: "payment-1",
      candidates: [{ id: "payment-1", label: "Payment", providerDefault: false }],
    },
    returnPolicy: {
      state: "bound",
      selectedId: "return-1",
      candidates: [{ id: "return-1", label: "Return", providerDefault: false }],
    },
    inventoryLocation: {
      state: "bound",
      selectedId: "location-1",
      candidates: [{ id: "location-1", label: "Location", providerDefault: false }],
    },
    discoveredAt: "2026-08-03T12:00:00.000Z",
  };
  const connection = {
    connection_generation: CONNECTION_GENERATION,
    ebay_username: "sandbox-seller",
    policy_location_bindings: { EBAY_US: binding },
  };
  const connectionState: { current: typeof connection | null } = {
    current: connection,
  };

  const client = {
    from(table: string) {
      if (table === "listings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: listing, error: null }) }),
          }),
          update: (patch: Record<string, unknown>) => {
            const filters: Array<[string, unknown]> = [];
            const builder = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              is(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              filter(column: string, _operator: string, value: string) {
                filters.push([column, JSON.parse(value)]);
                return builder;
              },
              async select() {
                const matches = filters.every(
                  ([column, value]) =>
                    JSON.stringify(listing[column as keyof typeof listing])
                    === JSON.stringify(value),
                );
                if (matches) Object.assign(listing, patch);
                return { data: matches ? [{ id: LISTING_ID }] : [], error: null };
              },
            };
            return builder;
          },
        };
      }
      if (table === "items") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: item, error: null }) }),
          }),
        };
      }
      if (table === "prediction_logs") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: { price: 199.99 }, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "ebay_connections") {
        return {
          select: () => ({
            maybeSingle: async () => ({ data: connectionState.current, error: null }),
          }),
        };
      }
      if (table === "notifications") {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    async rpc(name: string, params: Record<string, unknown>) {
      if (name === "disconnect_ebay_connection") {
        const disconnected = connectionState.current !== null;
        connectionState.current = null;
        return { data: disconnected, error: null };
      }
      if (name === "begin_ebay_publish") {
        if (params.p_expected_review_revision !== item.review_revision) {
          return { data: null, error: { code: "P0002", message: "Review changed." } };
        }
        item.review_revision = CLAIM_ID;
        listing.ebay_status = "publishing";
        listing.ebay_publish_claim_id = CLAIM_ID;
        return {
          data: {
            claimId: CLAIM_ID,
            listingId: LISTING_ID,
            itemId: ITEM_ID,
            title: listing.title,
            description: listing.description,
            copy: listing.copy,
            condition: item.condition,
            photos: item.photos,
            price: 199.99,
            priceOverride: item.price_override,
          },
          error: null,
        };
      }
      if (name === "bind_ebay_publish_connection_generation") {
        listing.ebay_publish_connection_generation = CONNECTION_GENERATION;
        listing.ebay_publish_binding = {
          marketplaceId: "EBAY_US",
          fulfillmentPolicyId: "fulfillment-1",
          paymentPolicyId: "payment-1",
          returnPolicyId: "return-1",
          merchantLocationKey: "location-1",
        };
        return { data: null, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((path) => ({
            path,
            signedUrl: `https://storage.example/${path}`,
          })),
          error: null,
        }),
      }),
    },
  } as unknown as SupabaseClient;

  return { client, connectionState, listing };
}

const idleWorker = {
  consume: async () => ({
    acknowledged: 0,
    claimed: 0,
    failed: 0,
    retrying: 0,
    skipped: 0,
    succeeded: 0,
  }),
};

function ebayHandler(input: {
  adapter: EbayAdapter;
  adapterFor?: () => Promise<EbayAdapter>;
  client: SupabaseClient;
  env?: Record<string, string | undefined>;
  requestId: string;
}) {
  return createMobileApiHandler({
    authenticate: async () => ({ kind: "clerk", userId: "user-1" }),
    ebayPublish: createMobileEbayPublishService({
      adapterFor: input.adapterFor ?? (async () => input.adapter),
      clientForBearer: () => input.client,
      completionClientForBearer: () => input.client,
      env: () => ({
        EBAY_BASE_URL: "https://api.sandbox.ebay.com",
        ...input.env,
      }),
    }),
    worker: idleWorker,
    requestId: () => input.requestId,
  });
}

function confirmedPublishRequest(
  handler: (request: Request) => Promise<Response>,
  expectedReviewRevision = REVIEW_REVISION,
) {
  return handler(
    new Request(`https://api.snaplist.test/v1/listings/${LISTING_ID}/ebay/publish`, {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-jwt",
        "content-type": "application/json",
        "idempotency-key": IDEMPOTENCY_KEY,
      },
      body: JSON.stringify({
        confirmation: "publish_to_ebay",
        expectedReviewRevision,
      }),
    }),
  );
}

describe("mobile eBay publish boundary", () => {
  it("replays an ambiguously acknowledged confirmation with one adapter mutation and one provider identity", async () => {
    const { client } = publishFixtureClient();
    const adapter = new AmbiguousAfterCompletionAdapter();
    const handler = ebayHandler({
      adapter,
      client,
      requestId: "request-628",
    });
    const publish = () => confirmedPublishRequest(handler);

    const first = await publish();
    const replay = await publish();

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      data: {
        outcome: "published",
        ebayListingId: `MOCK-EBAY-LISTING-${LISTING_ID}`,
      },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        outcome: "published",
        ebayListingId: `MOCK-EBAY-LISTING-${LISTING_ID}`,
      },
    });
    expect(adapter.requests).toHaveLength(1);
  });

  it("fails closed with 409 when confirmation uses a stale review revision", async () => {
    const { client } = publishFixtureClient();
    const adapter = new MockEbayAdapter();
    const handler = ebayHandler({
      adapter,
      client,
      requestId: "request-628-stale",
    });

    const response = await confirmedPublishRequest(
      handler,
      "88888888-8888-4888-8888-888888888888",
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "The listing changed since it was opened. Refresh before publishing.",
      },
    });
    expect(adapter.requests).toHaveLength(0);
  });

  it("rejects a publish request without explicit confirmation", async () => {
    const { client } = publishFixtureClient();
    const adapter = new MockEbayAdapter();
    const handler = ebayHandler({
      adapter,
      client,
      requestId: "request-628-unconfirmed",
    });

    const response = await handler(
      new Request(`https://api.snaplist.test/v1/listings/${LISTING_ID}/ebay/publish`, {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-jwt",
          "content-type": "application/json",
          "idempotency-key": IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ expectedReviewRevision: REVIEW_REVISION }),
      }),
    );

    expect(response.status).toBe(400);
    expect(adapter.requests).toHaveLength(0);
  });

  it("refuses a non-Sandbox adapter before any marketplace mutation", async () => {
    const { client } = publishFixtureClient();
    const adapter = new MockEbayAdapter();
    const handler = ebayHandler({
      adapter,
      client,
      env: { EBAY_BASE_URL: "https://api.ebay.com" },
      requestId: "request-628-production",
    });

    const response = await confirmedPublishRequest(handler);

    expect(response.status).toBe(503);
    expect(adapter.requests).toHaveLength(0);
  });

  it("preflights server-mapped listing truth without a marketplace mutation", async () => {
    const { client } = publishFixtureClient();
    const adapter = new MockEbayAdapter();
    const handler = ebayHandler({
      adapter,
      client,
      env: { EBAY_MARKETPLACE_ID: "EBAY_US" },
      requestId: "request-628-preflight",
    });

    const response = await handler(
      new Request(
        `https://api.snaplist.test/v1/listings/${LISTING_ID}/ebay/preflight`,
        { headers: { authorization: "Bearer clerk-jwt" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        listingId: LISTING_ID,
        title: "Nintendo Switch OLED",
        effectivePrice: { amount: 177.77, label: "What will be listed" },
        photoCount: 1,
        marketplace: "EBAY_US",
        ebayCondition: "LIKE_NEW",
        itemSpecifics: { Brand: ["Nintendo"], Model: ["Switch OLED"] },
        reviewRevision: REVIEW_REVISION,
      },
      meta: { requestId: "request-628-preflight" },
    });
    expect(adapter.requests).toHaveLength(0);
  });

  it("reports an ambiguous durable publish as outcome not yet known", async () => {
    const { client, listing } = publishFixtureClient();
    listing.ebay_status = "publishing";
    listing.ebay_publish_claim_id = CLAIM_ID;
    const adapter = new MockEbayAdapter();
    const handler = ebayHandler({
      adapter,
      client,
      requestId: "request-628-status",
    });

    const response = await handler(
      new Request(
        `https://api.snaplist.test/v1/listings/${LISTING_ID}/ebay/publish`,
        { headers: { authorization: "Bearer clerk-jwt" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        listingId: LISTING_ID,
        outcome: "outcome_not_yet_known",
        ebayListingId: null,
        ebayOfferId: null,
        alreadyPublished: false,
      },
      meta: { requestId: "request-628-status" },
    });
    expect(adapter.requests).toHaveLength(0);
  });

  it("reads and disconnects the account, then rejects replay from the old generation", async () => {
    const { client, connectionState } = publishFixtureClient();
    const adapter = new MockEbayAdapter();
    const handler = ebayHandler({
      adapter,
      adapterFor: async () => {
        if (!connectionState.current) {
          throw new Error("No eBay account is connected.");
        }
        return adapter;
      },
      client,
      requestId: "request-628-connection",
    });
    const publishRequest = () => confirmedPublishRequest(handler);

    expect((await publishRequest()).status).toBe(200);
    const connected = await handler(
      new Request("https://api.snaplist.test/v1/ebay/connection", {
        headers: { authorization: "Bearer clerk-jwt" },
      }),
    );
    expect(await connected.json()).toMatchObject({
      data: { connected: true, ebayUsername: "sandbox-seller" },
    });

    const disconnected = await handler(
      new Request("https://api.snaplist.test/v1/ebay/connection", {
        method: "DELETE",
        headers: {
          authorization: "Bearer clerk-jwt",
          "idempotency-key": IDEMPOTENCY_KEY,
        },
      }),
    );
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({
      data: { connected: false, ebayUsername: null },
    });

    const replay = await publishRequest();
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "Connect eBay before replaying this published listing.",
      },
    });
    expect(adapter.requests).toHaveLength(1);
  });
});
