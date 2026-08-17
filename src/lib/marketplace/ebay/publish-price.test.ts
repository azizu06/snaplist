import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpEbayAdapter } from "./http";
import { MockEbayAdapter } from "./mock";
import { publishListingToEbayAndNotify } from "./publish";
import {
  EbayWriteAmbiguousError,
  type EbayPublishFallbackBinding,
} from "./types";
import {
  fakePublishClient,
  type FakeListing,
} from "./publish.test-fixture";

/**
 * Fully offline contract tests for the shared publish service used by BOTH
 * outbound entry points: the listing server action and POST /api/ebay/publish.
 * The fake exposes only the caller-scoped Supabase surface the service uses;
 * the adapter remains the repository's offline mock, so no marketplace call is
 * possible here.
 */


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
    // The refusal names the condition without naming the RPC: the same branch
    // also fires when PostgREST refuses the call outright, and that message
    // carries the function name and privilege model (CWE-209).
    await expect(
      publishListingToEbayAndNotify(
        client,
        "user-1",
        listing.id,
        retryAdapter,
      ),
    ).rejects.toThrow("The eBay connection changed before publishing. Try again.");
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

  it("refuses to publish a partial photo set and never reaches eBay", async () => {
    // The token RPC skips any photo it cannot bind to a verified private
    // object, so a five-photo item can come back with three URLs. Listing an
    // item with photos silently missing misrepresents it, and the seller gets
    // no signal at all — so the whole publish fails instead.
    const { client, listing, notifications } = fakePublishClient(
      177.77,
      44.44,
      true,
      ["user-1/item-1.jpg", "user-1/item-2.jpg", "user-1/item-3.jpg"],
      2,
    );
    const adapter = new MockEbayAdapter();

    await expect(
      publishListingToEbayAndNotify(client, "user-1", listing.id, adapter),
    ).rejects.toThrowError(/3 photo\(s\) but only 2/i);

    expect(adapter.requests).toHaveLength(0);
    expect(listing).toMatchObject({
      ebay_status: "failed",
      ebay_listing_id: null,
    });
    expect(notifications).toEqual([
      expect.objectContaining({ kind: "listing_failed" }),
    ]);
  });

  it("publishes every photo when each one resolves into a fetchable URL", async () => {
    const { client, listing } = fakePublishClient(
      177.77,
      44.44,
      true,
      ["user-1/item-1.jpg", "user-1/item-2.jpg", "user-1/item-3.jpg"],
    );
    const adapter = new MockEbayAdapter();

    await publishListingToEbayAndNotify(client, "user-1", listing.id, adapter);

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.imageUrls).toHaveLength(3);
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
