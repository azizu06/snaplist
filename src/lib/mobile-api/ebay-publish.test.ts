import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createMobileApiHandler } from "./app";
import { createMobileEbayPublishService } from "@/lib/marketplace/ebay/mobile-publish";
import {
  EbayWriteAmbiguousError,
  MockEbayAdapter,
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
          select: () => ({ maybeSingle: async () => ({ data: connection, error: null }) }),
        };
      }
      if (table === "notifications") {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    async rpc(name: string, params: Record<string, unknown>) {
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

  return { client, listing };
}

describe("mobile eBay publish boundary", () => {
  it("replays an ambiguously acknowledged confirmation with one adapter mutation and one provider identity", async () => {
    const { client } = publishFixtureClient();
    const adapter = new AmbiguousAfterCompletionAdapter();
    const ebayPublish = createMobileEbayPublishService({
      adapterFor: async () => adapter,
      clientForBearer: () => client,
      completionClientForBearer: () => client,
      env: () => ({ EBAY_BASE_URL: "https://api.sandbox.ebay.com" }),
    });
    const handler = createMobileApiHandler({
      authenticate: async () => ({ kind: "clerk", userId: "user-1" }),
      ebayPublish,
      worker: {
        consume: async () => ({
          acknowledged: 0,
          claimed: 0,
          failed: 0,
          retrying: 0,
          skipped: 0,
          succeeded: 0,
        }),
      },
      requestId: () => "request-628",
    });
    const publish = () =>
      handler(
        new Request(`https://api.snaplist.test/v1/listings/${LISTING_ID}/ebay/publish`, {
          method: "POST",
          headers: {
            authorization: "Bearer clerk-jwt",
            "content-type": "application/json",
            "idempotency-key": IDEMPOTENCY_KEY,
          },
          body: JSON.stringify({
            confirmation: "publish_to_ebay",
            expectedReviewRevision: REVIEW_REVISION,
          }),
        }),
      );

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
});
