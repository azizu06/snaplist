import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { effectivePrice } from "../../pipeline";
import type {
  ApplyProviderTruthInput,
  EbayListingSyncAuthority,
  EbayListingSyncStore,
} from "./listing-sync";

/**
 * The Supabase side of post-publish eBay authority (issue #169).
 *
 * Reads run under the caller's RLS client. Writes go through ONE guarded
 * SECURITY DEFINER function that RE-CHECKS every fence resting on a row another
 * writer could move, against rows locked in the same transaction — the
 * migration names the exact set. The duplication is deliberate:
 * the service reads without a lock, so its answer is a proposal and only the
 * SQL statement can decide. One function rather than two is deliberate as well
 * — provider truth and the divergences it proves have to commit together.
 */

/**
 * Parses OUR OWN function result, narrowed by the function's return signature.
 * Extra keys are ignored rather than rejected — the row is ours, not seller
 * input, and strictness would make the read brittle against a future column.
 */
const authorityRowSchema = z.object({
  listing_id: z.string().uuid(),
  ebay_listing_id: z.string().nullable(),
  ebay_offer_id: z.string().nullable(),
  ebay_status: z.string().nullable(),
  marketplace_id: z.string(),
  review_revision: z.string().uuid(),
  // `numeric` arrives as number OR string depending on driver and magnitude;
  // the shared precedence helper normalizes both.
  suggested_price: z.union([z.number(), z.string()]).nullable(),
  price_override: z.union([z.number(), z.string()]).nullable(),
  account_generation: z.string().uuid().nullable(),
  connection_generation: z.string().uuid().nullable(),
  last_event_id: z.string().nullable(),
  provider_observed_at: z.string().nullable(),
});

/**
 * The currency persisted prices are denominated in. `prediction_logs` stores a
 * bare numeric and `items.price_override` follows it, so the read side must
 * make the currency claim explicitly — the same constant the publish path uses.
 *
 * KNOWN LIMITATION, deliberately not fixed here: this is a constant, not a
 * lookup from the listing's marketplace. A listing published to a non-USD
 * marketplace would compare eBay's own currency against "USD" and diverge on
 * every observation. Non-USD marketplace pricing semantics are an explicit
 * non-goal of issue #169's contract; the currency-mismatch test in
 * `listing-sync.test.ts` locks the comparison in and names the same limitation.
 * Recording it honestly beats a marketplace→currency map nothing else in the
 * codebase agrees on yet.
 */
const PRICING_CURRENCY = "USD";

export function createSupabaseEbayListingSyncStore(
  supabase: SupabaseClient,
): EbayListingSyncStore {
  return {
    async readAuthority(
      listingId: string,
    ): Promise<EbayListingSyncAuthority | null> {
      const { data, error } = await supabase.rpc(
        "read_ebay_listing_sync_authority",
        { p_listing_id: listingId },
      );
      if (error) {
        throw new Error(`Failed to read eBay sync authority: ${error.message}`);
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      const parsed = authorityRowSchema.parse(row);

      // A listing with no eBay connection has no account generation. Reporting
      // it as an empty string would let a fence "match" nothing; null makes the
      // service refuse, which is the honest answer.
      return {
        listingId: parsed.listing_id,
        ebayListingId: parsed.ebay_listing_id,
        ebayOfferId: parsed.ebay_offer_id,
        ebayStatus: parsed.ebay_status,
        marketplaceId: parsed.marketplace_id,
        reviewRevision: parsed.review_revision,
        effectivePrice: effectivePrice(
          parsed.suggested_price,
          parsed.price_override,
        ),
        currency: PRICING_CURRENCY,
        accountGeneration: parsed.account_generation ?? "",
        connectionGeneration: parsed.connection_generation,
        lastEventId: parsed.last_event_id,
        providerObservedAt: parsed.provider_observed_at,
      };
    },

    async applyProviderTruth(
      input: ApplyProviderTruthInput,
    ): Promise<"applied" | "superseded"> {
      const { data, error } = await supabase.rpc(
        "apply_ebay_listing_provider_truth",
        {
          p_conflicts: input.conflicts.map((conflict) => ({
            kind: conflict.kind,
            field: conflict.field,
            local_value: conflict.localValue,
            provider_value: conflict.providerValue,
            observed_at: conflict.observedAt,
          })),
          p_resolved_fields: input.convergedFields,
          p_listing_id: input.listingId,
          p_event_id: input.eventId,
          p_event_source: input.source,
          p_ebay_listing_id: input.ebayListingId,
          p_marketplace_id: input.marketplaceId,
          p_account_generation: input.accountGeneration,
          p_connection_generation: input.connectionGeneration,
          p_provider_status: input.providerStatus,
          p_provider_price_value: input.providerPrice,
          p_provider_price_currency: input.providerCurrency,
          p_provider_quantity: input.providerQuantity,
          p_provider_observed_at: input.providerObservedAt,
          p_expected_review_revision: input.expectedReviewRevision,
          p_expected_last_event_id: input.expectedLastEventId,
        },
      );
      if (error) {
        throw new Error(
          `Failed to persist confirmed eBay state: ${error.message}`,
        );
      }
      // Anything other than the two documented answers means the contract moved
      // underneath us; treating it as "applied" would report a write we cannot
      // prove happened.
      if (data !== "applied" && data !== "superseded") {
        throw new Error(
          `Unexpected eBay sync result ${JSON.stringify(data)} for listing ${input.listingId}`,
        );
      }
      return data;
    },
  };
}
