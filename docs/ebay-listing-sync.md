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
| Published, confirmed | eBay | Confirmed observations only |

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
8. **Compare** — status and cent-normalized price are each judged separately, producing one of three
   verdicts: **diverged** (a conflict), **converged** (evidence the dimension agrees again), or **no
   evidence**. A missing provider price is the third case; it may neither raise a conflict nor close
   one.
9. **Persist** — the guarded SQL function re-checks every fence above that rests on a row another
   writer could have moved, against rows locked in the same transaction, and returns `superseded` if
   one did. `marketplaceId` is the exception: `listings` stores no marketplace column, so there is no
   locked row to fence against; a concurrent writer is still caught, because moving the row also
   moves `last_event_id`.

The comparison happens **before** the write, so provider truth and the divergences it proves travel
into one statement together. That is not a style preference. The truth row carries `last_event_id`,
and a poll's event id is content-addressed; if the conflicts were a second write and it failed, the
retry would dedupe on an event id already committed and the divergence would be lost permanently.
That is silent last-write-wins, which this boundary exists to forbid. One function, one transaction,
both facts or neither.

The service reads without a lock, so its answer is a proposal. Only the SQL statement decides. That
duplication is the design, not redundancy.

## The conflict lifecycle

A conflict is open while `resolved_at is null`. A partial unique index keeps at most **one** open row
per `(user_id, listing_id, field)`, so a listing that keeps diverging is one unresolved problem
rather than a growing pile — a re-observation refreshes the existing row's provider evidence instead
of appending.

An observation that proves a dimension agrees again sets `resolved_at` on that dimension's open row,
in the same statement that records the truth. Without that, a seller who relisted at the old price
would keep staring at a conflict contradicted by live provider truth.

One exception: an open `ambiguousAcknowledgement` keeps its kind and its recorded local value when a
later observation refreshes it. Nothing writes that kind today — the outbound path that would have
produced it is a non-goal (below) — but the schema retains it and the ingest preserves it, because a
future confirmation surface must not have SnapList's "we do not know whether eBay applied this"
downgraded to a plain divergence by the next poll. A subsequent divergence is not an answer to that
question.

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

- **Any outbound marketplace mutation.** This slice is **ingest only**. An earlier revision carried
  `applyConfirmedEbayListingPrice`, which sent a seller-confirmed price through the adapter and
  persisted what eBay acknowledged. It was removed under review as an approved non-goal: ADR-0008
  keeps repricing outside the lean MVP, so a write path with no route, no cron, and no UI was
  contract scope this issue does not own. The comparison rule it protected survives where it
  matters — nothing may persist requested state, only observed state.
- **Order, fulfillment, post-sale, and sold-elsewhere sync.** ADR-0008 §8 places these outside the
  lean MVP and names #169 among the issues it scopes down. Only the listing-authority half survives.
- **Repricing, ending, and relisting surfaces.** `src/lib/marketplace/ebay/no-autonomous-repricing.test.ts`
  structurally forbids a `revisePrice` caller outside the adapter directory and a reprice cron route.
- **Non-USD marketplace pricing.** Persisted prices are compared against a `USD` constant, not a
  per-marketplace currency. A listing published to a non-USD marketplace would diverge on every
  observation. Named in `listing-sync-store.ts` and locked by a test rather than papered over.
- **Detecting a divergence only the local side moved.** A poll's event id is content-addressed over
  what eBay reported, and the ingest dedupes on it *before* comparing. A local edit made after
  publish against unchanged provider state therefore re-polls to an id already applied and is
  dropped before `compare()` runs; it surfaces on the next observation where eBay's own state moved.
  This boundary judges what an observation proves, not what the local row has since become.
- **A scheduler.** Nothing polls on a timer. The read seam exists; deciding when to call it is an
  operator decision that needs cost and rate-limit evidence first.
- **Notification subscriptions.** No hosted destination, no eBay subscription, no production
  credential.
- **Conflict resolution UI.** Conflicts are recorded and readable. Presenting and resolving them is a
  separate slice with its own approved design.

## Test seams

| Concern | Where |
| --- | --- |
| Ingest, dedupe, fences, divergence, re-convergence, write atomicity | `src/lib/marketplace/ebay/listing-sync.test.ts` (offline, transactional store fake) |
| Two-tenant isolation against the real database | `src/lib/marketplace/ebay/listing-sync.rls.test.ts` |
| RLS, grants, erasure coverage, guards, constraints | `supabase/tests/ebay_listing_sync_authority.test.sql` (structure) |
| `superseded` branches, fail-closed account fence, conflict lifecycle, truth-and-conflict atomicity | `supabase/tests/ebay_listing_sync_authority.test.sql` (executing) |
| No autonomous repricing caller | `src/lib/marketplace/ebay/no-autonomous-repricing.test.ts` |
