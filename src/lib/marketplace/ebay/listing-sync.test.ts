import { describe, expect, it } from "vitest";
import {
  ingestEbayListingObservation,
  readEbayListingObservation,
  type EbayListingSyncAuthority,
  type EbayListingSyncStore,
} from "./listing-sync";
import type {
  EbayListingSyncConflict,
  EbayListingSyncConflictField,
} from "./listing-sync-contract";
import { MockEbayAdapter } from "./mock";

/**
 * Post-publish provider authority (issue #169).
 *
 * The seam under test is the sync SERVICE, not the database: it decides what a
 * confirmed provider observation means for one already-published listing.
 * Persisting that decision behind the tenant fence is the store's job and is
 * proved separately (pgTAP + the RLS suite), so everything here runs offline
 * against an in-memory store and the mock adapter.
 */

const ACCOUNT_GENERATION = "11111111-1111-4111-8111-111111111111";
const CONNECTION_GENERATION = "22222222-2222-4222-8222-222222222222";
const REVIEW_REVISION = "33333333-3333-4333-8333-333333333333";
const LISTING_ID = "44444444-4444-4444-8444-444444444444";

function publishedAuthority(
  overrides: Partial<EbayListingSyncAuthority> = {},
): EbayListingSyncAuthority {
  return {
    listingId: LISTING_ID,
    ebayListingId: "EBAY-366590700178",
    ebayOfferId: "OFFER-1",
    ebayStatus: "published",
    marketplaceId: "EBAY_US",
    reviewRevision: REVIEW_REVISION,
    effectivePrice: 42.5,
    currency: "USD",
    accountGeneration: ACCOUNT_GENERATION,
    connectionGeneration: CONNECTION_GENERATION,
    lastEventId: null,
    providerObservedAt: null,
    ...overrides,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "EVENT-1",
    source: "poll" as const,
    ebayListingId: "EBAY-366590700178",
    marketplaceId: "EBAY_US",
    accountGeneration: ACCOUNT_GENERATION,
    connectionGeneration: CONNECTION_GENERATION,
    status: "active" as const,
    price: { value: "42.50", currency: "USD" },
    quantity: 1,
    observedAt: "2026-08-06T12:00:00.000Z",
    ...overrides,
  };
}

interface RecordedWrite {
  listingId: string;
  eventId: string;
  providerStatus: string | null;
  providerPrice: string | null;
  providerObservedAt: string;
  expectedReviewRevision: string;
  conflicts: EbayListingSyncConflict[];
  convergedFields: EbayListingSyncConflictField[];
}

/**
 * A store that persists the way the database does: ONE write per observation,
 * carrying provider truth and every conflict derived from it, committing both
 * or neither.
 *
 * That is the whole point of the seam. The event id a retry dedupes on advances
 * only when the write committed, so a failure cannot leave truth recorded with
 * its divergence missing and no second chance to record it.
 */
function inMemoryStore(
  authority: EbayListingSyncAuthority | null,
  options: { applyResult?: "applied" | "superseded" } = {},
) {
  const writes: RecordedWrite[] = [];
  const conflicts: EbayListingSyncConflict[] = [];
  let committed = authority;
  const database = {
    writes,
    conflicts,
    /**
     * Set to fail exactly the write that CARRIES a divergence, the way a fence
     * that moved mid-sync would. With truth and conflicts in one write there is
     * nothing half-applied to recover from. Were they two writes, this would be
     * the second one — and the first would already have advanced the event id
     * the retry dedupes on.
     */
    failConflictWriteWith: undefined as Error | undefined,
    get committed(): EbayListingSyncAuthority | null {
      return committed;
    },
    store: {
      readAuthority: async () => committed,
      applyProviderTruth: async (input) => {
        if (database.failConflictWriteWith && input.conflicts.length > 0) {
          throw database.failConflictWriteWith;
        }
        writes.push({
          listingId: input.listingId,
          eventId: input.eventId,
          providerStatus: input.providerStatus,
          providerPrice: input.providerPrice,
          providerObservedAt: input.providerObservedAt,
          expectedReviewRevision: input.expectedReviewRevision,
          conflicts: input.conflicts,
          convergedFields: input.convergedFields,
        });
        if ((options.applyResult ?? "applied") === "superseded") {
          return "superseded";
        }
        conflicts.push(...input.conflicts);
        committed = committed && {
          ...committed,
          lastEventId: input.eventId,
          providerObservedAt: input.providerObservedAt,
        };
        return "applied";
      },
    } satisfies EbayListingSyncStore,
  };
  return database;
}

describe("ingestEbayListingObservation", () => {
  it("persists confirmed provider truth for a published listing", async () => {
    const { store, writes } = inMemoryStore(publishedAuthority());

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation(),
      store,
    });

    expect(outcome).toEqual({
      state: "applied",
      providerTruth: {
        ebayListingId: "EBAY-366590700178",
        status: "active",
        price: { value: "42.50", currency: "USD" },
        quantity: 1,
        observedAt: "2026-08-06T12:00:00.000Z",
      },
      conflicts: [],
    });
    expect(writes).toEqual([
      {
        listingId: LISTING_ID,
        eventId: "EVENT-1",
        providerStatus: "active",
        providerPrice: "42.50",
        providerObservedAt: "2026-08-06T12:00:00.000Z",
        expectedReviewRevision: REVIEW_REVISION,
        conflicts: [],
        convergedFields: ["status", "price"],
      },
    ]);
  });

  // SnapList owns an unpublished draft outright. eBay acquires authority only
  // once a confirmed publish result supplies the external identity — before
  // that, a provider answer about "this listing" cannot be about this listing.
  it.each([
    ["a draft that never published", { ebayListingId: null, ebayStatus: null }],
    ["a publish still in flight", { ebayListingId: null, ebayStatus: "publishing" }],
    ["a failed publish", { ebayListingId: null, ebayStatus: "failed" }],
  ])("refuses an observation for %s", async (_name, overrides) => {
    const { store, writes, conflicts } = inMemoryStore(
      publishedAuthority(overrides),
    );

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation(),
      store,
    });

    expect(outcome).toEqual({ state: "refused", reason: "notPublished" });
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("refuses an observation for a listing that is not the caller's", async () => {
    const { store, writes } = inMemoryStore(null);

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation(),
      store,
    });

    expect(outcome).toEqual({ state: "refused", reason: "notPublished" });
    expect(writes).toEqual([]);
  });

  // Sync work carries the identity it was fetched under. A reconnect between
  // fetch and persist rotates the connection generation and, after an eBay
  // account deletion notice, the account generation — either one means the
  // answer in hand describes an account this row no longer belongs to.
  it.each([
    [
      "another eBay listing",
      { ebayListingId: "EBAY-999999999999" },
      "listingMismatch",
    ],
    [
      "a retired account generation",
      { accountGeneration: "99999999-9999-4999-8999-999999999999" },
      "accountGenerationChanged",
    ],
    [
      "a retired connection generation",
      { connectionGeneration: "88888888-8888-4888-8888-888888888888" },
      "connectionGenerationChanged",
    ],
    [
      "a reconnect that dropped to the operator fallback",
      { connectionGeneration: null },
      "connectionGenerationChanged",
    ],
  ])("refuses an observation about %s", async (_name, overrides, reason) => {
    const { store, writes, conflicts } = inMemoryStore(publishedAuthority());

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation(overrides),
      store,
    });

    expect(outcome).toEqual({ state: "refused", reason });
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("refuses an observation about the listing on another marketplace", async () => {
    const { store, writes } = inMemoryStore(publishedAuthority());

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({ marketplaceId: "EBAY_GB" }),
      store,
    });

    expect(outcome).toEqual({ state: "refused", reason: "listingMismatch" });
    expect(writes).toEqual([]);
  });

  // eBay's notification delivery is at-least-once and its ordering is not
  // guaranteed, so both defences are needed: the same event redelivered is the
  // same fact, and an event that observed the listing no earlier than the one
  // already held carries no newer truth.
  it("ignores a redelivered event without writing again", async () => {
    const { store, writes, conflicts } = inMemoryStore(
      publishedAuthority({
        lastEventId: "EVENT-1",
        providerObservedAt: "2026-08-06T12:00:00.000Z",
      }),
    );

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({ eventId: "EVENT-1" }),
      store,
    });

    expect(outcome).toEqual({ state: "ignored", reason: "duplicateEvent" });
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it.each([
    ["an earlier observation", "2026-08-06T11:59:59.000Z"],
    ["an observation at the same instant", "2026-08-06T12:00:00.000Z"],
  ])("ignores %s that arrived out of order", async (_name, observedAt) => {
    const { store, writes } = inMemoryStore(
      publishedAuthority({
        lastEventId: "EVENT-1",
        providerObservedAt: "2026-08-06T12:00:00.000Z",
      }),
    );

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({ eventId: "EVENT-0", observedAt }),
      store,
    });

    expect(outcome).toEqual({
      state: "ignored",
      reason: "supersededObservation",
    });
    expect(writes).toEqual([]);
  });

  // The point of the whole slice: eBay wins on external state, but the seller
  // is TOLD it changed. Recording provider truth and dropping the local value
  // on the floor would be last-write-wins with extra steps.
  it("records an explicit conflict when eBay ended a listing SnapList shows live", async () => {
    const { store, writes, conflicts } = inMemoryStore(publishedAuthority());

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({ eventId: "EVENT-2", status: "ended" }),
      store,
    });

    expect(outcome.state).toBe("applied");
    expect(outcome).toMatchObject({
      conflicts: [
        {
          kind: "providerDiverged",
          field: "status",
          ebayListingId: "EBAY-366590700178",
          localValue: "published",
          providerValue: "ended",
          observedAt: "2026-08-06T12:00:00.000Z",
        },
      ],
    });
    // Provider truth is still recorded — authority is eBay's, the conflict is
    // the seller's notice, and one does not replace the other.
    expect(writes).toHaveLength(1);
    expect(writes[0].providerStatus).toBe("ended");
    // One write carries both, under one listing id and one review revision, so
    // the conflict cannot land without the truth or the truth without it.
    expect(writes[0]).toMatchObject({
      listingId: LISTING_ID,
      expectedReviewRevision: REVIEW_REVISION,
      conflicts: [{ field: "status" }],
    });
    expect(conflicts).toHaveLength(1);
  });

  it("records an explicit conflict when the live eBay price left the seller's price behind", async () => {
    const { store, conflicts } = inMemoryStore(publishedAuthority());

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({
        eventId: "EVENT-2",
        price: { value: "39.99", currency: "USD" },
      }),
      store,
    });

    expect(outcome).toMatchObject({
      state: "applied",
      conflicts: [
        {
          kind: "providerDiverged",
          field: "price",
          localValue: "USD 42.50",
          providerValue: "USD 39.99",
        },
      ],
    });
    expect(conflicts).toHaveLength(1);
  });

  it("treats a differently written but identical price as agreement", async () => {
    const { store, conflicts } = inMemoryStore(
      publishedAuthority({ effectivePrice: 42.5 }),
    );

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({ eventId: "EVENT-2", price: { value: "42.5", currency: "USD" } }),
      store,
    });

    expect(outcome).toMatchObject({ state: "applied", conflicts: [] });
    expect(conflicts).toEqual([]);
  });

  it("flags a currency change rather than comparing the bare amounts", async () => {
    const { store } = inMemoryStore(publishedAuthority());

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({
        eventId: "EVENT-2",
        price: { value: "42.50", currency: "GBP" },
      }),
      store,
    });

    expect(outcome).toMatchObject({
      state: "applied",
      conflicts: [
        { field: "price", localValue: "USD 42.50", providerValue: "GBP 42.50" },
      ],
    });
  });

  it.each([
    ["eBay reported no price", { price: null }, { effectivePrice: 42.5 }],
    ["SnapList holds no price", {}, { effectivePrice: null }],
  ])(
    "raises no price conflict when %s",
    async (_name, observationOverrides, authorityOverrides) => {
      const { store, conflicts } = inMemoryStore(
        publishedAuthority(authorityOverrides),
      );

      const outcome = await ingestEbayListingObservation({
        listingId: LISTING_ID,
        observation: observation({ eventId: "EVENT-2", ...observationOverrides }),
        store,
      });

      expect(outcome).toMatchObject({ state: "applied", conflicts: [] });
      expect(conflicts).toEqual([]);
    },
  );

  it("refuses a malformed observation before reading local truth", async () => {
    const { store, writes } = inMemoryStore(publishedAuthority());

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      // A status eBay never reports. Persisting it would put a value in the
      // seller-facing record that nothing downstream knows how to say.
      observation: observation({ status: "shipped" }) as never,
      store,
    });

    expect(outcome).toEqual({
      state: "refused",
      reason: "malformedObservation",
    });
    expect(writes).toEqual([]);
  });

  it("reports a fence that moved between the decision and the write", async () => {
    const { store, conflicts } = inMemoryStore(publishedAuthority(), {
      applyResult: "superseded",
    });

    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({ status: "ended" }),
      store,
    });

    expect(outcome).toEqual({ state: "refused", reason: "concurrentChange" });
    // No conflict either: a decision made against a fence that has since moved
    // is not evidence of anything worth telling the seller.
    expect(conflicts).toEqual([]);
  });

  // The failure this seam exists to survive. Provider truth and the divergence
  // it disagrees with used to be two writes: the first advanced the event id a
  // retry dedupes on, so ANY failure of the second — a fence that moved, a
  // dropped connection, a crash — silently discarded the divergence forever.
  // A poll's event id is content-addressed, so the retry looks like the same
  // event and never gets a second chance. That is last-write-wins wearing a
  // conflict table.
  it("does not lose a divergence when the write carrying it fails", async () => {
    const database = inMemoryStore(publishedAuthority());
    const ended = observation({ eventId: "EVENT-2", status: "ended" });
    database.failConflictWriteWith = new Error(
      "the listing was corrected during sync",
    );

    await expect(
      ingestEbayListingObservation({
        listingId: LISTING_ID,
        observation: ended,
        store: database.store,
      }),
    ).rejects.toThrow("the listing was corrected during sync");

    // Neither half landed — including the event id, which is what keeps the
    // retry below from being dropped as a duplicate.
    expect(database.conflicts).toEqual([]);
    expect(database.committed?.lastEventId).toBeNull();

    database.failConflictWriteWith = undefined;
    const retry = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: ended,
      store: database.store,
    });

    expect(retry.state).toBe("applied");
    expect(database.conflicts).toMatchObject([
      { kind: "providerDiverged", field: "status", providerValue: "ended" },
    ]);
  });

  // A conflict that can only ever open is a conflict the seller can never clear.
  // When eBay's confirmed answer agrees with SnapList again, that dimension has
  // re-converged and its open row must close.
  it("reports a re-converged dimension so its open conflict closes", async () => {
    const { store, writes } = inMemoryStore(publishedAuthority());

    await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({
        eventId: "EVENT-2",
        price: { value: "39.99", currency: "USD" },
      }),
      store,
    });

    // Status agrees, price does not: only the agreeing dimension is reported as
    // resolved, and the disagreeing one is still an open conflict.
    expect(writes[0].convergedFields).toEqual(["status"]);
    expect(writes[0].conflicts).toMatchObject([{ field: "price" }]);
  });

  // Silence is not agreement. eBay reporting no price is no evidence either
  // way, so an open price conflict must NOT be closed on the strength of it.
  it("does not resolve a dimension neither side can be compared on", async () => {
    const { store, writes } = inMemoryStore(publishedAuthority());

    await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: observation({ eventId: "EVENT-2", price: null }),
      store,
    });

    expect(writes[0].convergedFields).toEqual(["status"]);
    expect(writes[0].conflicts).toEqual([]);
  });
});

describe("readEbayListingObservation", () => {
  const snapshot = {
    listingId: "EBAY-366590700178",
    listingStatus: "ACTIVE",
    price: { value: "44.00", currency: "USD" },
    availableQuantity: 1,
  };
  const now = () => new Date("2026-08-06T13:00:00.000Z");

  it("turns what eBay reports into an observation the sync service can apply", async () => {
    const adapter = new MockEbayAdapter({ listingSnapshot: snapshot });

    const read = await readEbayListingObservation({
      authority: publishedAuthority(),
      adapter,
      now,
    });

    expect(adapter.snapshotRequests).toEqual([
      { sku: LISTING_ID, offerId: "OFFER-1" },
    ]);
    expect(read).toEqual({
      state: "observed",
      observation: {
        eventId: "poll:EBAY-366590700178:active:USD 44.00:1",
        source: "poll",
        ebayListingId: "EBAY-366590700178",
        marketplaceId: "EBAY_US",
        accountGeneration: ACCOUNT_GENERATION,
        connectionGeneration: CONNECTION_GENERATION,
        status: "active",
        price: { value: "44.00", currency: "USD" },
        quantity: 1,
        observedAt: "2026-08-06T13:00:00.000Z",
      },
    });
  });

  // Polling has no provider event id to dedupe on, so the id is derived from
  // what eBay reported. Re-reading an unchanged listing therefore produces the
  // event SnapList already applied, and the ingest dedupe drops it — without a
  // provider timestamp and without an unbounded ledger of every poll.
  it("derives the same event id from an unchanged listing", async () => {
    const adapter = new MockEbayAdapter({ listingSnapshot: snapshot });
    const later = () => new Date("2026-08-06T14:00:00.000Z");

    const first = await readEbayListingObservation({
      authority: publishedAuthority(),
      adapter,
      now,
    });
    const second = await readEbayListingObservation({
      authority: publishedAuthority(),
      adapter,
      now: later,
    });

    expect(first.state).toBe("observed");
    expect(second.state).toBe("observed");
    const firstId = first.state === "observed" ? first.observation.eventId : null;
    const secondId =
      second.state === "observed" ? second.observation.eventId : null;
    expect(secondId).toBe(firstId);

    const { store, writes } = inMemoryStore(
      publishedAuthority({
        lastEventId: firstId,
        providerObservedAt: "2026-08-06T13:00:00.000Z",
      }),
    );
    const outcome = await ingestEbayListingObservation({
      listingId: LISTING_ID,
      observation: second.state === "observed" ? second.observation : observation(),
      store,
    });

    expect(outcome).toEqual({ state: "ignored", reason: "duplicateEvent" });
    expect(writes).toEqual([]);
  });

  it("reports a changed listing as a different event", async () => {
    const adapter = new MockEbayAdapter({
      listingSnapshot: { ...snapshot, listingStatus: "ENDED", price: null },
    });

    const read = await readEbayListingObservation({
      authority: publishedAuthority(),
      adapter,
      now,
    });

    expect(read).toMatchObject({
      state: "observed",
      observation: {
        eventId: "poll:EBAY-366590700178:ended:none:1",
        status: "ended",
        price: null,
      },
    });
  });

  // An adapter that cannot read must say so. Answering "nothing changed" would
  // let a capability gap masquerade as provider confirmation.
  it("reports an adapter that cannot read as unobservable", async () => {
    const read = await readEbayListingObservation({
      authority: publishedAuthority(),
      adapter: new MockEbayAdapter(),
      now,
    });

    expect(read).toEqual({
      state: "unobservable",
      reason: "capabilityUnavailable",
    });
  });

  it("refuses to poll a listing eBay has no authority over yet", async () => {
    const adapter = new MockEbayAdapter({ listingSnapshot: snapshot });

    const read = await readEbayListingObservation({
      authority: publishedAuthority({ ebayListingId: null, ebayStatus: null }),
      adapter,
      now,
    });

    expect(read).toEqual({ state: "unobservable", reason: "notPublished" });
    expect(adapter.snapshotRequests).toEqual([]);
  });

  it.each([
    ["eBay no longer recognises the offer", { listingId: null }],
    ["eBay reported no status at all", { listingStatus: null }],
    ["eBay reported a status SnapList cannot represent", { listingStatus: "PENDING_REVIEW" }],
  ])("reports no usable observation when %s", async (_name, overrides) => {
    const adapter = new MockEbayAdapter({
      listingSnapshot: { ...snapshot, ...overrides },
    });

    const read = await readEbayListingObservation({
      authority: publishedAuthority(),
      adapter,
      now,
    });

    expect(read).toEqual({
      state: "unobservable",
      reason: "unrecognizedProviderState",
    });
  });
});
