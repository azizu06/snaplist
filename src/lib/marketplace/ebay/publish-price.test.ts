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
  run_id: string | null;
  ebay_listing_id: string | null;
  ebay_offer_id: string | null;
  ebay_status: string | null;
  ebay_publish_claim_id: string | null;
  listed_price?: number;
  last_priced_at?: string;
}

function fakePublishClient(priceOverride: unknown, suggestedPrice = 44.44): {
  client: SupabaseClient;
  listing: FakeListing;
} {
  const reviewRevision = "review-revision-1";
  const claimId = "publish-claim-1";
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
            const builder = {
              eq(column: keyof FakeListing, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              async select() {
                const matches = filters.every(([column, value]) => listing[column] === value);
                if (!matches) return { data: [], error: null };
                Object.assign(listing, patch);
                return { data: [{ id: listing.id }], error: null };
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
    async rpc(name: string, params: Record<string, unknown>) {
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
