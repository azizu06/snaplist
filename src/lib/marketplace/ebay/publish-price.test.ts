import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MockEbayAdapter } from "./mock";
import { publishListingToEbayAndNotify } from "./publish";

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
  ebay_listing_id: string | null;
  ebay_offer_id: string | null;
  ebay_status: string | null;
  listed_price?: number;
  last_priced_at?: string;
}

function fakePublishClient(priceOverride: unknown, suggestedPrice = 44.44): {
  client: SupabaseClient;
  listing: FakeListing;
} {
  const listing: FakeListing = {
    id: "listing-1",
    item_id: "item-1",
    platform: "ebay",
    title: "Sony WH-1000XM4 Headphones",
    description: "Tested and ready to ship.",
    copy: { itemSpecifics: { Brand: "Sony" } },
    status: "draft",
    ebay_listing_id: null,
    ebay_offer_id: null,
    ebay_status: null,
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
          update: (patch: Partial<FakeListing>) => ({
            eq: async () => {
              Object.assign(listing, patch);
              return { error: null };
            },
          }),
        };
      }
      if (table === "items") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  condition: "good",
                  photos: ["user-1/item-1.jpg"],
                  price_override: priceOverride,
                },
                error: null,
              }),
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
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
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

describe("publishListingToEbayAndNotify effective-price contract", () => {
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
