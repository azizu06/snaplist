import { expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The offline publish double, shared by every contract test of the publish
 * service (#14, #891).
 *
 * It exposes only the caller-scoped Supabase surface `publishListingToEbay`
 * actually uses, so a test can prove publish behaviour without a database and
 * without any possibility of a marketplace call. Extracted from
 * `publish-price.test.ts` when the push contract needed the same double.
 */

export interface FakeListing {
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

export function fakePublishClient(
  priceOverride: unknown,
  suggestedPrice = 44.44,
  connected = true,
  photos: string[] = ["user-1/item-1.jpg"],
  issuedTokenCount = photos.length,
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
                  photos,
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
      if (name === "issue_ebay_photo_access_tokens") {
        // Pin the TTL the REAL publish path requests. Asserting the default
        // only where `issueEbayPhotoUrls` is called directly would leave
        // publish free to reintroduce its own week-long value unnoticed.
        expect(params.p_ttl_seconds).toBe(3600);
        // The RPC returns one row per photo it could bind to a private object.
        // It skips a photo whose Storage row or mimetype it cannot verify, so
        // a short list is the shape a partial drop actually arrives in.
        return {
          data: Array.from({ length: issuedTokenCount }, (_, ordinal) => ({
            photo_ordinal: ordinal,
            token: String.fromCharCode(65 + ordinal).repeat(43),
          })),
          error: null,
        };
      }
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
          photos,
          price: suggestedPrice,
          priceOverride,
        },
        error: null,
      };
    },
  } as unknown as SupabaseClient;

  return { client, listing, connection, connectionState, notifications };
}
