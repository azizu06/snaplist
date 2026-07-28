import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpEbayAdapter } from "./http";
import { MockEbayAdapter } from "./mock";
import { publishListingToEbayAndNotify } from "./publish";
import {
  EbayWriteAmbiguousError,
  type EbayPublishFallbackBinding,
} from "./types";

/**
 * Fully offline contract tests for the shared publish service used by BOTH
 * outbound entry points: the listing server action and POST /api/ebay/publish.
 * The fake exposes only the caller-scoped Supabase surface the service uses;
 * the adapter remains the repository's offline mock, so no marketplace call is
 * possible here.
 */

interface FakeListing {
  id: string;
  item_id: string;
  platform: string;
  title: string;
  description: string;
  copy: Record<string, unknown>;
  status: string;
  run_id: string | null;
  ebay_listing_id: string | null;
  ebay_offer_id: string | null;
  ebay_status: string | null;
  ebay_publish_claim_id: string | null;
  ebay_publish_connection_generation: string | null;
  ebay_publish_binding: Record<string, string> | null;
  listed_price?: number;
  last_priced_at?: string;
}

function fakePublishClient(
  priceOverride: unknown,
  suggestedPrice = 44.44,
  connected = true,
): {
  client: SupabaseClient;
  listing: FakeListing;
  connection: {
    connection_generation: string;
    policy_location_bindings: Record<string, unknown>;
  };
  connectionState: {
    current: {
      connection_generation: string;
      policy_location_bindings: Record<string, unknown>;
    } | null;
  };
  notifications: Array<Record<string, unknown>>;
} {
  const reviewRevision = "review-revision-1";
  const claimId = "publish-claim-1";
  const connectionGeneration = "11111111-1111-4111-8111-111111111111";
  const connection = {
    connection_generation: connectionGeneration,
    policy_location_bindings: {
      EBAY_US: {
        state: "ready",
        marketplaceId: "EBAY_US",
        connectionGeneration,
        fulfillmentPolicy: {
          state: "bound",
          selectedId: "fulfillment-1",
          candidates: [{
            id: "fulfillment-1",
            label: "Fulfillment",
            providerDefault: false,
          }],
        },
        paymentPolicy: {
          state: "bound",
          selectedId: "payment-1",
          candidates: [{
            id: "payment-1",
            label: "Payment",
            providerDefault: false,
          }],
        },
        returnPolicy: {
          state: "bound",
          selectedId: "return-1",
          candidates: [{
            id: "return-1",
            label: "Return",
            providerDefault: false,
          }],
        },
        inventoryLocation: {
          state: "bound",
          selectedId: "location-1",
          candidates: [{
            id: "location-1",
            label: "Location",
            providerDefault: false,
          }],
        },
        discoveredAt: "2026-07-27T12:00:00.000Z",
      },
    },
  };
  const connectionState = { current: connected ? connection : null };
  const notifications: Array<Record<string, unknown>> = [];
  const listing: FakeListing = {
    id: "listing-1",
    item_id: "item-1",
    platform: "ebay",
    title: "Sony WH-1000XM4 Headphones",
    description: "Tested and ready to ship.",
    copy: { itemSpecifics: { Brand: "Sony" } },
    status: "draft",
    run_id: null,
    ebay_listing_id: null,
    ebay_offer_id: null,
    ebay_status: null,
    ebay_publish_claim_id: null,
    ebay_publish_connection_generation: null,
    ebay_publish_binding: null,
  };

  const client = {
    from(table: string) {
      if (table === "listings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: listing, error: null }),
            }),
          }),
          update: (patch: Partial<FakeListing>) => {
            const filters: Array<[keyof FakeListing, unknown]> = [];
            const apply = () => {
              const matches = filters.every(
                ([column, value]) =>
                  JSON.stringify(listing[column]) === JSON.stringify(value),
              );
              if (matches) Object.assign(listing, patch);
              return { data: matches ? [{ id: listing.id }] : [], error: null };
            };
            const builder = {
              eq(column: keyof FakeListing, value: unknown) {
                filters.push([
                  column,
                  value !== null && typeof value === "object"
                    ? String(value)
                    : value,
                ]);
                return builder;
              },
              is(column: keyof FakeListing, value: null) {
                filters.push([column, value]);
                return builder;
              },
              filter(
                column: keyof FakeListing,
                operator: string,
                value: string,
              ) {
                if (operator !== "eq") {
                  throw new Error(`unexpected filter operator ${operator}`);
                }
                filters.push([column, JSON.parse(value)]);
                return builder;
              },
              async select() {
                return apply();
              },
              then<TResult1 = ReturnType<typeof apply>, TResult2 = never>(
                onFulfilled?:
                  | ((value: ReturnType<typeof apply>) => TResult1 | PromiseLike<TResult1>)
                  | null,
                onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ) {
                return Promise.resolve(apply()).then(onFulfilled, onRejected);
              },
            };
            return builder;
          },
        };
      }
      if (table === "items") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  review_revision: reviewRevision,
                  condition: "good",
                  photos: ["user-1/item-1.jpg"],
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "ebay_connections") {
        return {
          select: () => ({
            maybeSingle: async () => ({
              data: connectionState.current,
              error: null,
            }),
          }),
        };
      }
      if (table === "prediction_logs") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { price: suggestedPrice },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "notifications") {
        return {
          insert: async (notification: Record<string, unknown>) => {
            notifications.push(notification);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(name: string, params: Record<string, unknown>) {
      if (name === "bind_ebay_publish_connection_generation") {
        const requestedBinding = {
          marketplaceId: params.p_marketplace_id as string,
          fulfillmentPolicyId: params.p_fulfillment_policy_id as string,
          paymentPolicyId: params.p_payment_policy_id as string,
          returnPolicyId: params.p_return_policy_id as string,
          merchantLocationKey: params.p_merchant_location_key as string,
        };
        if (
          params.p_listing_id !== listing.id
          || params.p_claim_id !== claimId
          || params.p_connection_generation
            !== connectionState.current?.connection_generation
          || (
            listing.ebay_publish_connection_generation !== null
            && (
              listing.ebay_publish_connection_generation
                !== params.p_connection_generation
              || JSON.stringify(listing.ebay_publish_binding)
                !== JSON.stringify(requestedBinding)
            )
          )
        ) {
          return { data: null, error: { message: "binding changed" } };
        }
        listing.ebay_publish_connection_generation =
          params.p_connection_generation as string;
        listing.ebay_publish_binding = requestedBinding;
        return { data: null, error: null };
      }
      if (name !== "begin_ebay_publish") {
        throw new Error(`unexpected rpc ${name}`);
      }
      if (
        params.p_listing_id !== listing.id ||
        params.p_expected_run_id !== listing.run_id ||
        params.p_expected_review_revision !== reviewRevision
      ) {
        return {
          data: null,
          error: { code: "P0002", message: "Publish snapshot changed." },
        };
      }
      listing.ebay_status = "publishing";
      listing.ebay_publish_claim_id = claimId;
      return {
        data: {
          claimId,
          listingId: listing.id,
          itemId: listing.item_id,
          title: listing.title,
          description: listing.description,
          copy: listing.copy,
          condition: "good",
          photos: ["user-1/item-1.jpg"],
          price: suggestedPrice,
          priceOverride,
        },
        error: null,
      };
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

  return { client, listing, connection, connectionState, notifications };
}

describe("publishListingToEbayAndNotify effective-price contract", () => {
  it("retains exact publish provenance when an eBay write may have committed", async () => {
    const { client, listing, connection } = fakePublishClient(177.77);
    const initialGeneration = connection.connection_generation;
    const adapter = new MockEbayAdapter();
    adapter.failWith = new EbayWriteAmbiguousError(
      "eBay PUT ended without an acknowledgement",
      0,
      new Error("socket closed"),
    );

    await expect(
      publishListingToEbayAndNotify(
        client,
        "user-1",
        listing.id,
        adapter,
      ),
    ).rejects.toBe(adapter.failWith);

    expect(adapter.requests).toHaveLength(1);
    expect(listing).toMatchObject({
      ebay_status: "publishing",
      ebay_publish_claim_id: "publish-claim-1",
      ebay_publish_connection_generation: connection.connection_generation,
      ebay_publish_binding: {
        marketplaceId: "EBAY_US",
        fulfillmentPolicyId: "fulfillment-1",
        paymentPolicyId: "payment-1",
        returnPolicyId: "return-1",
        merchantLocationKey: "location-1",
      },
    });

    // A same-generation recovery can learn only that eBay already has an
    // offer, not which offer it is. That remains maybe-committed provenance.
    listing.ebay_status = "failed";
    listing.ebay_publish_claim_id = null;
    const recoveryCalls: string[] = [];
    const unresolvedConflictAdapter = new HttpEbayAdapter({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        recoveryCalls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        if (url.includes("/inventory_item/")) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/sell/inventory/v1/offer") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              errors: [{
                errorId: 25002,
                message: "Offer entity already exists.",
              }],
            }),
            { status: 400 },
          );
        }
        if (url.includes("/sell/inventory/v1/offer?sku=")) {
          return new Response(JSON.stringify({ offers: [] }), { status: 200 });
        }
        throw new Error(`unexpected fake eBay call: ${url}`);
      }) as typeof fetch,
      tokenProvider: {
        getAccessToken: async () => "test-access-token",
      },
      env: () => ({ EBAY_BASE_URL: "https://mock-ebay.invalid" }),
    });

    const recoveryError = await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      unresolvedConflictAdapter,
    ).catch((error: unknown) => error);

    expect(recoveryCalls).toHaveLength(3);
    expect(listing.ebay_publish_connection_generation).toBe(initialGeneration);
    expect(listing.ebay_publish_binding).toEqual({
      marketplaceId: "EBAY_US",
      fulfillmentPolicyId: "fulfillment-1",
      paymentPolicyId: "payment-1",
      returnPolicyId: "return-1",
      merchantLocationKey: "location-1",
    });
    expect(recoveryError).toBeInstanceOf(EbayWriteAmbiguousError);

    // Simulate claim expiry, then a reconnect that presents a new ready
    // generation. The prior maybe-committed attempt must remain pinned and the
    // replacement attempt must stop before reaching the adapter.
    listing.ebay_status = "failed";
    listing.ebay_publish_claim_id = null;
    const replacementGeneration = "22222222-2222-4222-8222-222222222222";
    connection.connection_generation = replacementGeneration;
    (
      connection.policy_location_bindings.EBAY_US as {
        connectionGeneration: string;
      }
    ).connectionGeneration = replacementGeneration;
    const retryAdapter = new MockEbayAdapter();
    await expect(
      publishListingToEbayAndNotify(
        client,
        "user-1",
        listing.id,
        retryAdapter,
      ),
    ).rejects.toThrow(/connection changed before provider dispatch/i);
    expect(retryAdapter.requests).toHaveLength(0);
    expect(listing.ebay_publish_connection_generation).toBe(initialGeneration);
    expect(listing.ebay_publish_binding).toEqual({
      marketplaceId: "EBAY_US",
      fulfillmentPolicyId: "fulfillment-1",
      paymentPolicyId: "payment-1",
      returnPolicyId: "return-1",
      merchantLocationKey: "location-1",
    });
  });

  it("clears generation and binding together after a definite pre-ack failure", async () => {
    const { client, listing, notifications } = fakePublishClient(177.77);
    const adapter = new MockEbayAdapter();
    adapter.failWith = new Error("eBay rejected the offer before acknowledgement");

    await expect(
      publishListingToEbayAndNotify(
        client,
        "user-1",
        listing.id,
        adapter,
      ),
    ).rejects.toBe(adapter.failWith);

    expect(adapter.requests).toHaveLength(1);
    expect(listing).toMatchObject({
      ebay_status: "failed",
      ebay_publish_claim_id: null,
      ebay_publish_connection_generation: null,
      ebay_publish_binding: null,
    });
    expect(notifications).toEqual([
      expect.objectContaining({ kind: "listing_failed" }),
    ]);
  });

  it("returns a durable same-generation replay before requiring a ready binding", async () => {
    const { client, listing, connection } = fakePublishClient(177.77);
    const adapter = new MockEbayAdapter();

    const first = await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      adapter,
    );

    expect(first.alreadyPublished).toBe(false);
    for (const policy_location_bindings of [
      {},
      {
        EBAY_US: {
          state: "setupRequired",
          marketplaceId: "EBAY_US",
          connectionGeneration: connection.connection_generation,
          fulfillmentPolicy: {
            state: "setupRequired",
            selectedId: null,
            candidates: [],
          },
          paymentPolicy: {
            state: "setupRequired",
            selectedId: null,
            candidates: [],
          },
          returnPolicy: {
            state: "setupRequired",
            selectedId: null,
            candidates: [],
          },
          inventoryLocation: {
            state: "setupRequired",
            selectedId: null,
            candidates: [],
          },
          discoveredAt: "2026-07-27T12:00:00.000Z",
        },
      },
      {
        EBAY_US: {
          state: "selectionRequired",
          marketplaceId: "EBAY_US",
          connectionGeneration: connection.connection_generation,
          fulfillmentPolicy: {
            state: "selectionRequired",
            selectedId: null,
            candidates: [
              { id: "fulfillment-a", label: "First", providerDefault: false },
              { id: "fulfillment-b", label: "Second", providerDefault: false },
            ],
          },
          paymentPolicy: {
            state: "bound",
            selectedId: "payment-1",
            candidates: [{
              id: "payment-1",
              label: "Payment",
              providerDefault: false,
            }],
          },
          returnPolicy: {
            state: "bound",
            selectedId: "return-1",
            candidates: [{
              id: "return-1",
              label: "Return",
              providerDefault: false,
            }],
          },
          inventoryLocation: {
            state: "bound",
            selectedId: "location-1",
            candidates: [{
              id: "location-1",
              label: "Location",
              providerDefault: false,
            }],
          },
          discoveredAt: "2026-07-27T12:00:00.000Z",
        },
      },
    ]) {
      connection.policy_location_bindings = policy_location_bindings;
      const replay = await publishListingToEbayAndNotify(
        client,
        "user-1",
        listing.id,
        adapter,
      );
      expect(replay.alreadyPublished).toBe(true);
      expect(adapter.requests).toHaveLength(1);
    }

    connection.connection_generation = "22222222-2222-4222-8222-222222222222";
    await expect(
      publishListingToEbayAndNotify(client, "user-1", listing.id, adapter),
    ).rejects.toThrow(/connection changed/i);
    expect(adapter.requests).toHaveLength(1);

    const operator = fakePublishClient(177.77, 44.44, false);
    const operatorAdapter = Object.assign(new MockEbayAdapter(), {
      getPublishFallbackBinding: (): EbayPublishFallbackBinding => ({
        marketplaceId: "EBAY_US",
        connectionGeneration: null,
        fulfillmentPolicyId: "operator-fulfillment",
        paymentPolicyId: "operator-payment",
        returnPolicyId: "operator-return",
        merchantLocationKey: "operator-location",
      }),
    });
    const operatorFirst = await publishListingToEbayAndNotify(
      operator.client,
      "operator-user",
      operator.listing.id,
      operatorAdapter,
    );
    const operatorReplay = await publishListingToEbayAndNotify(
      operator.client,
      "operator-user",
      operator.listing.id,
      operatorAdapter,
    );
    expect(operatorFirst.alreadyPublished).toBe(false);
    expect(operatorReplay.alreadyPublished).toBe(true);
    expect(operatorAdapter.requests).toHaveLength(1);
  });

  it.each([
    {
      name: "seller reconnect",
      storedGeneration: "original" as const,
      currentGeneration: "replacement" as const,
    },
    {
      name: "legacy null-generation row",
      storedGeneration: "legacy-null" as const,
      currentGeneration: "original" as const,
    },
  ])(
    "does not record a false publish failure for a provider-authoritative replay after $name",
    async ({ storedGeneration, currentGeneration }) => {
      const { client, listing, connection, notifications } =
        fakePublishClient(177.77);
      const originalGeneration = connection.connection_generation;
      const replacementGeneration =
        "22222222-2222-4222-8222-222222222222";
      listing.status = "published";
      listing.ebay_status = "published";
      listing.ebay_listing_id = "provider-listing-1";
      listing.ebay_offer_id = "provider-offer-1";
      listing.ebay_publish_connection_generation =
        storedGeneration === "original" ? originalGeneration : null;
      connection.connection_generation =
        currentGeneration === "original"
          ? originalGeneration
          : replacementGeneration;
      const adapter = new MockEbayAdapter();

      await expect(
        publishListingToEbayAndNotify(
          client,
          "user-1",
          listing.id,
          adapter,
        ),
      ).rejects.toThrow(/connection changed after this listing was published/i);

      expect(adapter.requests).toHaveLength(0);
      expect(notifications).toEqual([]);
      expect(listing).toMatchObject({
        status: "published",
        ebay_status: "published",
        ebay_listing_id: "provider-listing-1",
        ebay_offer_id: "provider-offer-1",
      });
    },
  );

  it("binds the publish claim through the tenant server authority client", async () => {
    const { client, listing } = fakePublishClient(177.77);
    const authorityRpcs: string[] = [];
    const completionClient = {
      from: client.from.bind(client),
      rpc: async (name: string, params: Record<string, unknown>) => {
        authorityRpcs.push(name);
        return client.rpc(name, params);
      },
    } as unknown as SupabaseClient;

    await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      new MockEbayAdapter(),
      { completionClient },
    );

    expect(authorityRpcs).toEqual([
      "bind_ebay_publish_connection_generation",
    ]);
  });

  it.each(["server action", "API route"])(
    "%s publishes the seller override through the shared service",
    async () => {
      const { client, listing } = fakePublishClient(177.77);
      const adapter = new MockEbayAdapter();

      await publishListingToEbayAndNotify(
        client,
        "user-1",
        listing.id,
        adapter,
      );

      expect(adapter.requests[0]?.price).toEqual({
        value: "177.77",
        currency: "USD",
      });
      expect(listing.listed_price).toBe(177.77);
    },
  );

  it.each([
    { label: "missing", override: null },
    { label: "invalid", override: "not-a-price" },
  ])("falls back to the latest AI suggestion for a $label override", async ({ override }) => {
    const { client, listing } = fakePublishClient(override);
    const adapter = new MockEbayAdapter();

    await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      adapter,
    );

    expect(adapter.requests[0]?.price).toEqual({
      value: "44.44",
      currency: "USD",
    });
    expect(listing.listed_price).toBe(44.44);
  });
});
