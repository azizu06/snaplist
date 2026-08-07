import { z } from "zod";

/**
 * The post-publish provider-authority contract (issue #169).
 *
 * SnapList owns an UNPUBLISHED draft outright. The moment a confirmed publish
 * result supplies an external listing id, eBay owns that listing's external
 * state and SnapList holds a copy — never the other way round. Everything in
 * this module describes that copy and the evidence behind it, so no other layer
 * has to decide what "eBay says" means.
 *
 * Two rules are load-bearing and are encoded here rather than in prose:
 *
 *  1. Only a CONFIRMED provider result may become local truth. There is no
 *     schema for optimistic intent, so a caller cannot accidentally persist
 *     what it merely asked eBay to do.
 *  2. Divergence is data, not a silent overwrite. A conflict carries the local
 *     value, the provider value, and when eBay observed it, so the seller
 *     resolves it with the same facts SnapList had.
 */

/**
 * eBay's listing lifecycle, reduced to the states that change what SnapList
 * should say about a published item. Deliberately small: a state SnapList
 * cannot act on honestly does not belong in a seller-facing record.
 */
export const ebayProviderListingStatuses = [
  "active",
  "ended",
  "completed",
  "outOfStock",
] as const;

export type EbayProviderListingStatus =
  (typeof ebayProviderListingStatuses)[number];

/** A provider money value; `value` is a decimal string per the Sell API. */
export const ebayProviderMoneySchema = z
  .object({
    value: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
    currency: z.string().length(3),
  })
  .strict();

export type EbayProviderMoney = z.infer<typeof ebayProviderMoneySchema>;

/**
 * ONE confirmed observation of a live eBay listing.
 *
 * `eventId` is the provider's identity for this observation — a notification id
 * when eBay pushed it, a deterministic poll key when SnapList pulled it. It is
 * what makes redelivery idempotent, so it is required even for polls.
 *
 * The generations travel WITH the observation instead of being read at write
 * time. A reconnect between fetching and persisting must not be able to graft
 * one eBay account's answer onto another's listing.
 */
export const ebayListingObservationSchema = z
  .object({
    eventId: z.string().min(1).max(255),
    source: z.enum(["poll", "notification"]),
    ebayListingId: z.string().min(1).max(64),
    marketplaceId: z.string().min(1).max(32),
    accountGeneration: z.string().uuid(),
    /** Null only for the exact operator Sandbox fallback, which has no connection row. */
    connectionGeneration: z.string().uuid().nullable(),
    status: z.enum(ebayProviderListingStatuses),
    /** Absent when eBay reported a state that carries no price (an ended listing may). */
    price: ebayProviderMoneySchema.nullable(),
    quantity: z.number().int().min(0).max(1_000_000).nullable(),
    observedAt: z.string().datetime(),
  })
  .strict();

export type EbayListingObservation = z.infer<
  typeof ebayListingObservationSchema
>;

/** The confirmed provider state SnapList now holds for one published listing. */
export interface EbayListingProviderTruth {
  ebayListingId: string;
  /**
   * Null when the confirmed answer carried no lifecycle claim — a confirmed
   * price revision does not observe whether the listing is still active, and
   * inventing "active" from silence would be exactly the optimistic write this
   * module exists to prevent.
   */
  status: EbayProviderListingStatus | null;
  price: EbayProviderMoney | null;
  quantity: number | null;
  observedAt: string;
}

/**
 * What diverged. `kind` says WHY there is a conflict at all:
 *
 *  - `providerDiverged` — eBay's confirmed state disagrees with what SnapList
 *    holds locally. The provider value is authoritative; the local value is
 *    kept so the seller can see what changed rather than watching it vanish.
 *  - `ambiguousAcknowledgement` — SnapList sent a seller-confirmed change and
 *    eBay's answer did not confirm the outcome. NOTHING is persisted as truth;
 *    the conflict records the attempt so a retry cannot guess.
 */
export const ebayListingSyncConflictKinds = [
  "providerDiverged",
  "ambiguousAcknowledgement",
] as const;

export type EbayListingSyncConflictKind =
  (typeof ebayListingSyncConflictKinds)[number];

/** The comparable dimensions. One conflict row per dimension, never a blob. */
export const ebayListingSyncConflictFields = ["status", "price"] as const;

export type EbayListingSyncConflictField =
  (typeof ebayListingSyncConflictFields)[number];

export interface EbayListingSyncConflict {
  kind: EbayListingSyncConflictKind;
  field: EbayListingSyncConflictField;
  ebayListingId: string;
  /** What SnapList held. `null` means SnapList held nothing comparable. */
  localValue: string | null;
  /** What eBay confirmed. `null` means eBay's answer did not carry the value. */
  providerValue: string | null;
  observedAt: string;
}

/**
 * Cent-normalized comparison. Two decimal strings that name the same amount
 * ("42.5" and "42.50") are the same price, and a float subtraction is not
 * allowed to decide that. Returns null when either side is uncomparable, which
 * the caller must treat as "no evidence of divergence", never as "equal".
 */
export function ebayPriceCents(value: string): number | null {
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
