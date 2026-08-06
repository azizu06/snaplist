import { describe, expect, it } from "vitest";
import {
  applyConfirmedEbayListingPrice,
  ingestEbayListingObservation,
  readEbayListingObservation,
  type EbayListingSyncAuthority,
  type EbayListingSyncStore,
} from "./listing-sync";
import { MockEbayAdapter } from "./mock";
import { EbayApiError, EbayWriteAmbiguousError } from "./types";

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
}

function inMemoryStore(
  authority: EbayListingSyncAuthority | null,
  options: { applyResult?: "applied" | "superseded" } = {},
): {
  store: EbayListingSyncStore;
  writes: RecordedWrite[];
  conflicts: OpenedConflict[];
} {
  const writes: RecordedWrite[] = [];
  const conflicts: OpenedConflict[] = [];
  return {
    writes,
    conflicts,
    store: {
      readAuthority: async () => authority,
      applyProviderTruth: async (input) => {
        writes.push({
          listingId: input.listingId,
          eventId: input.eventId,
          providerStatus: input.providerStatus,
          providerPrice: input.providerPrice,
          providerObservedAt: input.providerObservedAt,
          expectedReviewRevision: input.expectedReviewRevision,
        });
        return options.applyResult ?? "applied";
      },
      openConflict: async (input) => {
        conflicts.push(input);
      },
    },
  };
}

type OpenedConflict = Parameters<EbayListingSyncStore["openConflict"]>[0];

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
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      listingId: LISTING_ID,
      expectedReviewRevision: REVIEW_REVISION,
    });
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
});

describe("applyConfirmedEbayListingPrice", () => {
  const CONFIRMATION = {
    confirmationId: "CONFIRM-1",
    expectedReviewRevision: REVIEW_REVISION,
    price: { value: "39.99", currency: "USD" },
  };
  const now = () => new Date("2026-08-06T12:30:00.000Z");

  it("persists only what eBay confirmed", async () => {
    const { store, writes, conflicts } = inMemoryStore(publishedAuthority());
    const adapter = new MockEbayAdapter();

    const outcome = await applyConfirmedEbayListingPrice({
      listingId: LISTING_ID,
      confirmation: CONFIRMATION,
      adapter,
      store,
      now,
    });

    expect(adapter.reviseRequests).toEqual([
      {
        sku: LISTING_ID,
        offerId: "OFFER-1",
        price: { value: "39.99", currency: "USD" },
      },
    ]);
    expect(outcome).toMatchObject({
      state: "applied",
      providerTruth: {
        ebayListingId: "EBAY-366590700178",
        price: { value: "39.99", currency: "USD" },
        observedAt: "2026-08-06T12:30:00.000Z",
      },
      conflicts: [],
    });
    // A confirmed price revision says nothing about the listing's lifecycle, so
    // it must not overwrite the status the last observation established.
    expect(writes).toEqual([
      {
        listingId: LISTING_ID,
        eventId: "CONFIRM-1",
        providerStatus: null,
        providerPrice: "39.99",
        providerObservedAt: "2026-08-06T12:30:00.000Z",
        expectedReviewRevision: REVIEW_REVISION,
      },
    ]);
    expect(conflicts).toEqual([]);
  });

  // The dangerous case. eBay may have applied the change; SnapList does not
  // know. Writing the requested price would state as truth something nobody
  // confirmed, and the next poll would then find no divergence to report.
  it("persists nothing and opens a conflict when eBay's answer is ambiguous", async () => {
    const { store, writes, conflicts } = inMemoryStore(publishedAuthority());
    const adapter = new MockEbayAdapter();
    adapter.reviseFailWith = new EbayWriteAmbiguousError(
      "eBay price revision for offer OFFER-1 returned no per-offer confirmation",
      200,
      {},
    );

    const outcome = await applyConfirmedEbayListingPrice({
      listingId: LISTING_ID,
      confirmation: CONFIRMATION,
      adapter,
      store,
      now,
    });

    expect(writes).toEqual([]);
    expect(outcome).toMatchObject({
      state: "ambiguous",
      conflicts: [
        {
          kind: "ambiguousAcknowledgement",
          field: "price",
          ebayListingId: "EBAY-366590700178",
          localValue: "USD 39.99",
          providerValue: null,
          observedAt: "2026-08-06T12:30:00.000Z",
        },
      ],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      listingId: LISTING_ID,
      expectedReviewRevision: REVIEW_REVISION,
    });
  });

  it("rethrows a plainly failed revision instead of inventing a conflict", async () => {
    const { store, writes, conflicts } = inMemoryStore(publishedAuthority());
    const adapter = new MockEbayAdapter();
    adapter.reviseFailWith = new EbayApiError("offer status 400", 400, {});

    await expect(
      applyConfirmedEbayListingPrice({
        listingId: LISTING_ID,
        confirmation: CONFIRMATION,
        adapter,
        store,
        now,
      }),
    ).rejects.toThrow(EbayApiError);
    expect(writes).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("refuses a confirmation the seller gave against an older review", async () => {
    const { store, writes } = inMemoryStore(publishedAuthority());
    const adapter = new MockEbayAdapter();

    const outcome = await applyConfirmedEbayListingPrice({
      listingId: LISTING_ID,
      confirmation: {
        ...CONFIRMATION,
        expectedReviewRevision: "55555555-5555-4555-8555-555555555555",
      },
      adapter,
      store,
      now,
    });

    expect(outcome).toEqual({
      state: "refused",
      reason: "reviewRevisionChanged",
    });
    expect(adapter.reviseRequests).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("refuses to mutate a listing eBay has no authority over yet", async () => {
    const { store } = inMemoryStore(
      publishedAuthority({ ebayListingId: null, ebayStatus: null }),
    );
    const adapter = new MockEbayAdapter();

    const outcome = await applyConfirmedEbayListingPrice({
      listingId: LISTING_ID,
      confirmation: CONFIRMATION,
      adapter,
      store,
      now,
    });

    expect(outcome).toEqual({ state: "refused", reason: "notPublished" });
    expect(adapter.reviseRequests).toEqual([]);
  });

  it("does not send a replayed confirmation to eBay a second time", async () => {
    const { store, writes } = inMemoryStore(
      publishedAuthority({
        lastEventId: "CONFIRM-1",
        providerObservedAt: "2026-08-06T12:30:00.000Z",
      }),
    );
    const adapter = new MockEbayAdapter();

    const outcome = await applyConfirmedEbayListingPrice({
      listingId: LISTING_ID,
      confirmation: CONFIRMATION,
      adapter,
      store,
      now,
    });

    expect(outcome).toEqual({ state: "ignored", reason: "duplicateEvent" });
    expect(adapter.reviseRequests).toEqual([]);
    expect(writes).toEqual([]);
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
