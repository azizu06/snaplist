import {
  ebayListingObservationSchema,
  ebayPriceCents,
  ebayProviderListingStatuses,
  ebayProviderMoneySchema,
  type EbayListingObservation,
  type EbayListingProviderTruth,
  type EbayListingSyncConflict,
  type EbayListingSyncConflictField,
  type EbayProviderListingStatus,
  type EbayProviderMoney,
} from "./listing-sync-contract";
import type { EbayAdapter } from "./types";

/**
 * Post-publish eBay authority (issue #169).
 *
 * SnapList owns a draft until a confirmed publish result supplies an external
 * listing id. From that moment eBay owns the listing's external state, and this
 * module is the only place that decides what a confirmed provider answer means
 * for the local copy. It is deliberately decision-only: every write goes through
 * the store seam, whose Supabase implementation re-checks the same fences inside
 * one guarded statement, so a fence that passed here cannot be stale by the time
 * it lands.
 */

/**
 * What SnapList currently believes about one listing, read under RLS. This is
 * the LOCAL side of every comparison; nothing here is provider truth.
 */
export interface EbayListingSyncAuthority {
  listingId: string;
  /** Null until a confirmed publish supplied one — authority has not begun. */
  ebayListingId: string | null;
  /** The Sell Inventory offer behind the live listing; needed to revise it. */
  ebayOfferId: string | null;
  /** The local publish lifecycle: 'published' | 'publishing' | 'failed' | null. */
  ebayStatus: string | null;
  marketplaceId: string;
  reviewRevision: string;
  /** The seller's effective price in whole currency units, or null. */
  effectivePrice: number | null;
  currency: string;
  accountGeneration: string;
  connectionGeneration: string | null;
  /** The provider event last applied, for redelivery dedupe. */
  lastEventId: string | null;
  /** When eBay observed the state SnapList currently holds. */
  providerObservedAt: string | null;
}

export interface ApplyProviderTruthInput {
  listingId: string;
  eventId: string;
  source: "poll" | "notification";
  ebayListingId: string;
  marketplaceId: string;
  accountGeneration: string;
  connectionGeneration: string | null;
  /** Null leaves the held status alone: a confirmed price says nothing about it. */
  providerStatus: string | null;
  providerPrice: string | null;
  providerCurrency: string | null;
  providerQuantity: number | null;
  providerObservedAt: string;
  /** The review revision the decision was made at; the write fails closed if it moved. */
  expectedReviewRevision: string;
  /** The event the decision was made against; the write fails closed if it moved. */
  expectedLastEventId: string | null;
  /**
   * Every divergence this observation proves, recorded WITH the truth it
   * disagrees with. Splitting the two across writes would let a failure between
   * them commit provider truth while the divergence is lost — and the event id
   * this write advances would make the retry look like a duplicate, so it would
   * be lost permanently.
   */
  conflicts: EbayListingSyncConflict[];
  /**
   * Dimensions this observation proves have re-converged: both sides were
   * comparable and they agree. Any open conflict on one of them is closed by
   * the same write. Absence means "no evidence", never "they agree".
   */
  convergedFields: EbayListingSyncConflictField[];
}

export interface EbayListingSyncStore {
  /** The local truth for one listing, or null when the listing is not the caller's. */
  readAuthority(listingId: string): Promise<EbayListingSyncAuthority | null>;
  /**
   * Persist confirmed provider truth AND its conflicts behind the tenant fence,
   * atomically. `superseded` means the fence moved between decision and write;
   * the caller must not retry with the same stale decision.
   */
  applyProviderTruth(
    input: ApplyProviderTruthInput,
  ): Promise<"applied" | "superseded">;
}

export type EbayListingSyncOutcome =
  | {
      state: "applied";
      providerTruth: EbayListingProviderTruth;
      conflicts: EbayListingSyncConflict[];
    }
  | { state: "ignored"; reason: "duplicateEvent" | "supersededObservation" }
  | { state: "refused"; reason: EbayListingSyncRefusal };

export type EbayListingSyncRefusal =
  /** No confirmed publish result yet — eBay has no authority over this draft. */
  | "notPublished"
  /** The observation describes a different eBay listing than this row's. */
  | "listingMismatch"
  | "accountGenerationChanged"
  | "connectionGenerationChanged"
  /** The fence moved between reading local truth and writing provider truth. */
  | "concurrentChange"
  /** The observation is not a valid confirmed provider answer. */
  | "malformedObservation";

export async function ingestEbayListingObservation(input: {
  listingId: string;
  observation: EbayListingObservation;
  store: EbayListingSyncStore;
}): Promise<EbayListingSyncOutcome> {
  const parsed = ebayListingObservationSchema.safeParse(input.observation);
  if (!parsed.success) {
    return { state: "refused", reason: "malformedObservation" };
  }
  const observation = parsed.data;

  const authority = await input.store.readAuthority(input.listingId);
  // A missing row and an unpublished row are the same refusal on purpose: both
  // mean "eBay has no authority here", and distinguishing them would tell an
  // unauthenticated caller whether someone else's listing id exists.
  if (
    !authority
    || !authority.ebayListingId
    || authority.ebayStatus !== "published"
  ) {
    return { state: "refused", reason: "notPublished" };
  }

  if (
    observation.ebayListingId !== authority.ebayListingId
    || observation.marketplaceId !== authority.marketplaceId
  ) {
    return { state: "refused", reason: "listingMismatch" };
  }
  if (observation.accountGeneration !== authority.accountGeneration) {
    return { state: "refused", reason: "accountGenerationChanged" };
  }
  if (observation.connectionGeneration !== authority.connectionGeneration) {
    return { state: "refused", reason: "connectionGenerationChanged" };
  }

  // Redelivery is expected, not exceptional: eBay's push notifications are
  // at-least-once and a poll re-reads whatever is live. The event identity
  // catches the same fact arriving twice; the observation clock catches a
  // stale fact arriving after a newer one, including a redelivery that lost
  // its identity. `<=` rather than `<` because two answers stamped at the same
  // instant give no evidence which is newer, and guessing would let an older
  // state overwrite a newer one.
  if (authority.lastEventId && observation.eventId === authority.lastEventId) {
    return { state: "ignored", reason: "duplicateEvent" };
  }
  if (
    authority.providerObservedAt
    && Date.parse(observation.observedAt)
      <= Date.parse(authority.providerObservedAt)
  ) {
    return { state: "ignored", reason: "supersededObservation" };
  }

  // Compared BEFORE the write, so the divergence travels with the truth it
  // disagrees with and the two cannot land separately.
  const comparison = compare(authority, observation);
  const applied = await input.store.applyProviderTruth({
    listingId: authority.listingId,
    eventId: observation.eventId,
    source: observation.source,
    ebayListingId: observation.ebayListingId,
    marketplaceId: observation.marketplaceId,
    accountGeneration: observation.accountGeneration,
    connectionGeneration: observation.connectionGeneration,
    providerStatus: observation.status,
    providerPrice: observation.price?.value ?? null,
    providerCurrency: observation.price?.currency ?? null,
    providerQuantity: observation.quantity,
    providerObservedAt: observation.observedAt,
    expectedReviewRevision: authority.reviewRevision,
    expectedLastEventId: authority.lastEventId,
    conflicts: comparison.conflicts,
    convergedFields: comparison.convergedFields,
  });
  if (applied === "superseded") {
    return { state: "refused", reason: "concurrentChange" };
  }
  const conflicts = comparison.conflicts;

  return {
    state: "applied",
    providerTruth: {
      ebayListingId: observation.ebayListingId,
      status: observation.status,
      price: observation.price,
      quantity: observation.quantity,
      observedAt: observation.observedAt,
    },
    conflicts,
  };
}

/**
 * The result of asking eBay what it currently reports for a published listing.
 *
 * `unobservable` is a first-class answer, not an error. A capability gap, a
 * still-unpublished draft, and a provider state SnapList cannot represent all
 * mean the same thing operationally — there is nothing here that may become
 * local truth — and none of them may be reported as "unchanged".
 */
export type EbayListingObservationRead =
  | { state: "observed"; observation: EbayListingObservation }
  | {
      state: "unobservable";
      reason:
        | "capabilityUnavailable"
        | "notPublished"
        | "unrecognizedProviderState";
    };

/**
 * Read one published listing's current external state from eBay (issue #169).
 *
 * This is the polling half of provider authority. Polling exists because eBay's
 * push notifications are at-least-once AND at-most-eventually: a dropped
 * notification would otherwise leave SnapList showing an item eBay ended.
 *
 * A poll carries no provider event id, so the id is derived from what eBay
 * reported. Re-reading an unchanged listing therefore yields the id already
 * applied and the ingest dedupe drops it — idempotent polling with neither a
 * provider timestamp nor an unbounded ledger of every read.
 */
export async function readEbayListingObservation(input: {
  authority: EbayListingSyncAuthority;
  adapter: Pick<EbayAdapter, "getListingSnapshot">;
  now?: () => Date;
}): Promise<EbayListingObservationRead> {
  const { authority } = input;
  if (!publishedAuthority(authority) || !authority.ebayOfferId) {
    return { state: "unobservable", reason: "notPublished" };
  }
  const read = input.adapter.getListingSnapshot?.bind(input.adapter);
  if (!read) return { state: "unobservable", reason: "capabilityUnavailable" };

  const snapshot = await read({
    sku: authority.listingId,
    offerId: authority.ebayOfferId,
  });
  const status = providerListingStatus(snapshot.listingStatus);
  if (!snapshot.listingId || !status) {
    return { state: "unobservable", reason: "unrecognizedProviderState" };
  }

  const price = snapshot.price
    ? ebayProviderMoneySchema.parse(snapshot.price)
    : null;
  // The listing id comes from eBay's answer, not from what SnapList expected:
  // an offer that maps to a different listing must reach the ingest fence as a
  // mismatch rather than be quietly relabelled here.
  const observation = ebayListingObservationSchema.parse({
    eventId: pollEventId(snapshot.listingId, status, price, snapshot.availableQuantity),
    source: "poll",
    ebayListingId: snapshot.listingId,
    marketplaceId: authority.marketplaceId,
    accountGeneration: authority.accountGeneration,
    connectionGeneration: authority.connectionGeneration,
    status,
    price,
    quantity: snapshot.availableQuantity,
    observedAt: (input.now?.() ?? new Date()).toISOString(),
  } satisfies EbayListingObservation);

  return { state: "observed", observation };
}

/**
 * A content-addressed poll id: same reported state, same id. Deliberately
 * readable rather than hashed, so an operator reading a stuck row can see WHICH
 * state SnapList last accepted instead of a digest.
 */
function pollEventId(
  ebayListingId: string,
  status: EbayProviderListingStatus,
  price: EbayProviderMoney | null,
  quantity: number | null,
): string {
  const money = price ? `${price.currency} ${price.value}` : "none";
  return `poll:${ebayListingId}:${status}:${money}:${quantity ?? "none"}`;
}

/** eBay's status vocabulary, narrowed to what SnapList can honestly show. */
function providerListingStatus(
  reported: string | null,
): EbayProviderListingStatus | null {
  if (!reported) return null;
  const normalized = reported.trim().toLowerCase().replace(/[\s_-]/g, "");
  return (
    ebayProviderListingStatuses.find(
      (status) => status.toLowerCase() === normalized,
    ) ?? null
  );
}

/**
 * Whether eBay has authority over this row at all.
 *
 * A missing row and an unpublished row are the same answer on purpose: both
 * mean "eBay has no authority here", and distinguishing them would tell a
 * caller whether someone else's listing id exists.
 */
function publishedAuthority(
  authority: EbayListingSyncAuthority | null,
): authority is EbayListingSyncAuthority & { ebayListingId: string } {
  return Boolean(
    authority
    && authority.ebayListingId
    && authority.ebayStatus === "published",
  );
}

/**
 * What the confirmed provider answer proves about each dimension: that it
 * disagrees with SnapList, that it agrees again, or nothing at all.
 *
 * The third answer is why this returns two lists rather than one. A missing
 * provider price or a local listing with no price yet is NO EVIDENCE: it may
 * not raise a conflict the seller never observed, and it may not close one
 * either, because silence is not agreement. Only a dimension both sides carry
 * a comparable value for gets a verdict.
 */
function compare(
  authority: EbayListingSyncAuthority,
  observation: EbayListingObservation,
): {
  conflicts: EbayListingSyncConflict[];
  convergedFields: EbayListingSyncConflictField[];
} {
  const conflicts: EbayListingSyncConflict[] = [];
  const convergedFields: EbayListingSyncConflictField[] = [];
  const base = {
    kind: "providerDiverged" as const,
    ebayListingId: observation.ebayListingId,
    observedAt: observation.observedAt,
  };

  // SnapList shows a published listing as live. Any other provider state means
  // the seller is looking at something that is no longer true on eBay. eBay
  // always reports a status, so this dimension always reaches a verdict.
  if (observation.status === "active") {
    convergedFields.push("status");
  } else {
    conflicts.push({
      ...base,
      field: "status",
      localValue: authority.ebayStatus,
      providerValue: observation.status,
    });
  }

  const local = authority.effectivePrice;
  const provider = observation.price;
  if (local != null && provider) {
    const localCents = ebayPriceCents(local.toFixed(2));
    const providerCents = ebayPriceCents(provider.value);
    const diverged =
      provider.currency !== authority.currency
      || localCents == null
      || providerCents == null
      || localCents !== providerCents;
    if (diverged) {
      conflicts.push({
        ...base,
        field: "price",
        localValue: `${authority.currency} ${local.toFixed(2)}`,
        providerValue: `${provider.currency} ${formatProviderAmount(provider.value)}`,
      });
    } else {
      convergedFields.push("price");
    }
  }

  return { conflicts, convergedFields };
}

/** Two decimal places, so the seller compares like with like. */
function formatProviderAmount(value: string): string {
  const cents = ebayPriceCents(value);
  return cents == null ? value : (cents / 100).toFixed(2);
}
