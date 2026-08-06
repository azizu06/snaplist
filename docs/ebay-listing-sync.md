# eBay listing sync: provider authority after publish

Issue [#169](https://github.com/azizu06/snaplist/issues/169). This document describes the
post-publish authority boundary, how a provider observation reaches SnapList, and what deliberately
does not exist yet.

**Nothing here activates a hosted subscription, a production credential, or a scheduler.** The seams
are built and proved offline; turning any of them on is a separate, operator-controlled decision.

## Who owns what

SnapList owns an unpublished draft outright — identity, copy, condition, price, everything.

That ownership ends the moment a confirmed publish returns an external listing id. From then on eBay
owns the listing's external state, and SnapList holds a **copy** of it. The copy is only ever written
from a confirmed provider answer. There is no schema for optimistic intent, so a caller cannot
persist what it merely asked eBay to do.

When the copy and the local record disagree, the disagreement is recorded as an explicit conflict
carrying both values. It is never resolved by overwriting one side.

| State | Owner | Written from |
| --- | --- | --- |
| Draft, never published | SnapList | Seller edits, pipeline output |
| `ebay_status = 'publishing'` | SnapList | Publish claim; sync refuses to touch it |
| Published, confirmed | eBay | Confirmed observations and confirmed mutations only |

## How an observation arrives

Both paths produce the same validated `EbayListingObservation` and go through the same
`ingestEbayListingObservation` decision. Neither path may write around it.

### Polling (built)

`EbayAdapter.getListingSnapshot` reads `GET /sell/inventory/v1/offer/{offerId}` with the seller's own
token. `readEbayListingObservation` turns that snapshot into an observation.

A poll carries no provider event id, so the id is derived from what eBay reported:

```
poll:<ebayListingId>:<status>:<currency> <amount>:<quantity>
```

Re-reading an unchanged listing therefore produces the id SnapList already applied, and the ingest
dedupe drops it. That gives idempotent polling without a provider timestamp (the Sell Inventory offer
response carries none) and without an unbounded ledger of every read.

The id is content-addressed rather than a hash so an operator reading a stuck row can see **which**
state was last accepted, not a digest.

### Notifications (fallback, not activated)

eBay's Notification API delivers listing changes over a subscribed destination. It is
**at-least-once**: the same event can arrive several times, and it can also silently fail to arrive.

SnapList does not subscribe today. Doing so requires a hosted HTTPS destination, an eBay-side
subscription, and a production credential — all owner-controlled and outside this slice.

When it is activated, a notification becomes an observation with `source: "notification"` and eBay's
own notification id as `eventId`. Nothing else changes: redelivery hits the same dedupe that
re-polling does.

**Polling remains necessary even after notifications are live.** A dropped notification would
otherwise leave SnapList showing an item eBay ended. Notifications lower latency; polling is what
makes the copy eventually correct.

## What the ingest decides

In order, and writing nothing until every one passes:

1. **Shape** — the observation parses against its Zod contract, or `malformedObservation`.
2. **Authority** — the listing is `published` with an eBay listing id, or `notPublished`.
3. **Identity** — the observation's `ebayListingId` and `marketplaceId` match, or `listingMismatch`.
4. **Account generation** — matches the current one, or `accountGenerationChanged`. An eBay account
   deletion notice rotates this.
5. **Connection generation** — matches, or `connectionGenerationChanged`. A reconnect rotates this.
6. **Dedupe** — `eventId` equals the last applied one, so the answer is already recorded.
7. **Monotonicity** — `observedAt` must strictly advance. Equal timestamps are refused too: two
   answers at the same instant carry no evidence of which is newer.
8. **Persist** — the guarded SQL function re-checks every fence above against rows locked in the
   same transaction, and returns `superseded` if another writer moved the row in between.
9. **Compare** — status and cent-normalized price are compared, and each divergence opens its own
   conflict row. Provider truth is still recorded; the conflict explains it, it does not block it.

The service reads without a lock, so its answer is a proposal. Only the SQL statement decides. That
duplication is the design, not redundancy.

## Confirmed local mutations

`applyConfirmedEbayListingPrice` sends **one** seller-confirmed price change through the adapter and
persists only what eBay confirmed.

- A confirmed acknowledgement writes the new price as provider truth.
- An `EbayWriteAmbiguousError` writes **nothing** and opens an `ambiguousAcknowledgement` conflict
  recording what was attempted. A retry then has evidence instead of a guess.
- Any other failure rethrows without inventing a conflict.
- A replayed confirmation is dropped by the same dedupe that drops a redelivered notification: the
  seller's `confirmationId` is the event id.

There is **no autonomous caller and no deployed entry point** — no route, no cron, no UI. Launch has
no autonomous marketplace actions (AGENTS.md; ADR-0008 §7). What this function fixes is the
accounting, so that when a confirmation surface is built it cannot write optimistically.

A caller that wrote the requested price first would erase its own evidence: the next observation
would compare eBay against the price SnapList merely asked for and find no divergence to report.

## Tenancy

Both tables carry the Clerk `user_id`, enable RLS, and grant `authenticated` **select only**. There
is no update or delete policy — a seller cannot edit the provider's answer into agreement.

Writes go exclusively through `SECURITY DEFINER` functions that require both an authenticated Clerk
identity and server-API authorization (`private.is_server_api_request()`), then resolve the tenant
from `public.clerk_user_id()`. They never accept a `user_id` argument.

Erasure coverage is structural: both tables carry the account-erasure fence trigger and appear in
`private.account_erasure_owned_row_count`, so completion cannot be reported while a sync row
survives. `src/lib/account-erasure/fence-coverage.rls.test.ts` enforces this for every tenant table.

## What is deliberately absent

- **Order, fulfillment, post-sale, and sold-elsewhere sync.** ADR-0008 §8 places these outside the
  lean MVP and names #169 among the issues it scopes down. Only the listing-authority half survives.
- **Repricing, ending, and relisting surfaces.** `src/lib/marketplace/ebay/no-autonomous-repricing.test.ts`
  structurally forbids a `revisePrice` caller outside the adapter directory and a reprice cron route.
- **A scheduler.** Nothing polls on a timer. The read seam exists; deciding when to call it is an
  operator decision that needs cost and rate-limit evidence first.
- **Notification subscriptions.** No hosted destination, no eBay subscription, no production
  credential.
- **Conflict resolution UI.** Conflicts are recorded and readable. Presenting and resolving them is a
  separate slice with its own approved design.

## Test seams

| Concern | Where |
| --- | --- |
| Ingest, dedupe, fences, divergence, ambiguity | `src/lib/marketplace/ebay/listing-sync.test.ts` (offline, mock adapter) |
| Two-tenant isolation against the real database | `src/lib/marketplace/ebay/listing-sync.rls.test.ts` |
| RLS, grants, erasure coverage, guards, constraints | `supabase/tests/ebay_listing_sync_authority.test.sql` |
| No autonomous repricing caller | `src/lib/marketplace/ebay/no-autonomous-repricing.test.ts` |
