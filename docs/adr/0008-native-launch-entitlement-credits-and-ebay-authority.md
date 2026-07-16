# ADR-0008 — Native launch entitlement, AI-item credits, and eBay authority

- **Status:** Accepted (2026-07-16)
- **Decider:** Aziz
- **Owned by:** issue #166 (documentation contract); implementation is split into linked follow-ups
- **Related existing owners:** issue #153 / PR #155 (legacy server capacity policy), issue #159 /
  PR #164 (durable upload/run integration), issues #161 and #162 (durable recovery and operations)

## Context

SnapList's implemented web contracts grew around a volume-first reseller posture, daily Free/Pro
capacity, optional safe-fact auto-send, and scheduled repricing. The native launch decisions instead
optimize for an average consumer reseller reaching one useful result before account creation. They
also require precise credit settlement and make eBay—not SnapList—the source of truth after publish.

This ADR records the target native contract without changing the implementation owned by PR #155,
draft PR #164, #161, or #162. Existing daily server limits may continue as operational guardrails
until a linked implementation issue reconciles them; they are not the native entitlement or a public
allowance promise.

## Decision

### 1. First value and guest allowance

- Pre-value onboarding has no seller questionnaire. Optional category/frequency personalization may
  appear only after a usable first draft and remains skippable.
- One device may receive one guest allowance backed by a verified App Attest assertion.
- The guest allowance contains exactly one complete AI item run and exactly one guided identity
  correction for the same item and same photo set.
- Manual editing of identity, condition, title, description, item specifics, photos, and price does
  not consume an AI-item credit. If an edit requests provider-backed full re-analysis, replaces or
  adds photos, or creates a second item, it is a new complete AI item run.
- The guided correction is included only when it keeps the original item identity and immutable
  photo-set fingerprint. It may regenerate fields that depend on corrected identity through the
  shared pricing/confidence/listing seams. It cannot silently become a second complete analysis.
- Account creation and eBay connection become blocking only when the guest chooses **Publish to
  eBay**. Authentication claims the same guest item/run/draft atomically and returns to that draft;
  claim does not create a second reservation or consume a credit.

### 2. Usable draft is the settlement point

A **usable draft** exists only when one coherent, seller-readable result is durably committed:

1. the item and validated identity/condition attributes exist;
2. one price recommendation exists with range, confidence, tier, and the citations required by that
   tier (or the honest terminal `llm-only` label); and
3. one editable listing draft exists for the item at the same coherent review revision.

Partial stage checkpoints, provider output not yet persisted, a queue acknowledgement by itself, an
item without editable listing copy, or a failed/canceled run do not qualify. Low-confidence or
terminal-fallback output may qualify when it is honest, coherent, and fully editable.

### 3. AI-item credit accounting

- Reserve one AI-item credit before provider-backed work begins. The reservation belongs to the
  logical complete AI item run, not an HTTP request, worker attempt, queue message delivery, process,
  or device session.
- A logical reservation has one terminal outcome: **settled** or **restored**. Both transitions are
  idempotent and monotonic.
- Settle exactly once when the usable draft transaction succeeds. Queue acknowledgement happens
  after durable success and cannot be the billing event.
- Restore exactly once when the run fails or is canceled before a usable draft exists. A retry after
  restoration must explicitly reserve a new complete run; delayed duplicate deliveries of the old
  run cannot spend or restore again.
- Internal model/schema retries, queue redelivery, crash recovery, resumable stage checkpoints, and
  the one included guided correction reuse the same logical reservation.
- Cancellation or deletion after a usable draft exists does not restore the already settled credit.
- The first usable listing and its first seller-confirmed eBay publish are free. Editing, saving, or
  publishing that existing draft does not spend another AI-item credit.
- Seller Pro's hard paywall appears when complete AI item run #2 attempts to reserve. Seller Pro has
  a configurable monthly AI-item allowance. StoreKit supplies localized price and subscription
  state; the public item count stays unset until TestFlight measures median and p95 cost per usable
  item.
- Legacy per-day item and per-minute request limits are separate abuse/capacity guardrails. They must
  not be labeled monthly credits or used as the native product promise.

Required contract tests include same-run retries, queue redelivery, crash recovery, guided
correction, manual edits, changed photo sets, cancel/fail before settlement, cancel/delete after
settlement, guest-to-account claim, duplicate callbacks, monthly boundary, and concurrent run-#2
reservation.

### 4. eBay authority and synchronization

- SnapList owns an unpublished local draft.
- A seller-confirmed publish intent is revision-guarded and sent through the eBay adapter. eBay
  authority begins only after a confirmed provider result supplies the external listing identity and
  state.
- After publish, eBay is authoritative for listing, order, payment, fulfillment, and post-sale truth.
  External changes synchronize into SnapList. A seller-confirmed local change goes through the
  appropriate adapter and local state reflects the confirmed eBay result, not optimistic intent.
- When local intent, cached state, and current eBay truth disagree—or provider acknowledgement is
  ambiguous—SnapList records and shows a sync conflict. It never resolves the conflict with silent
  last-write-wins behavior.
- No publish, reprice, end, relist, fulfillment write, or message send is autonomous at launch.
  Readiness/confidence may recommend an action but never authorizes it.

### 5. Allowlisted launch post-sale mutations

The standard eBay Fulfillment API may read orders, payment state, fulfillment state, tracking, and
ship-by instructions. Launch direct mutations are limited to:

1. **Add tracking / mark shipped:** after explicit seller confirmation,
   `createShippingFulfillment` may create the shipping fulfillment with carrier/tracking data.
   Fulfillment `FULFILLED` means shipped/fulfilled by the seller, not confirmed carrier delivery.
2. **End a listing recorded sold elsewhere:** the confirmation asks for marketplace, sale price,
   and optional fees/cost. **Also end on eBay** is selected by default but remains one explicit
   seller confirmation. Use Inventory `withdrawOffer` for a SnapList-managed offer. A non-Inventory
   listing may use the appropriate Trading end call only when seller ownership and external mapping
   are verified.

Standard Fulfillment does not provide dependable carrier-delivered truth, and the Logistics API is
Limited Release. Delivered status is shown only when a separately approved authoritative source
supports it; otherwise SnapList links to eBay. Cancellations, refunds, returns/cases, disputes, and
label purchasing remain readable status and honest eBay handoff surfaces at launch. Their financial,
regional, signature, and Sandbox constraints are not launch mutation contracts.

### 6. Assisted launch marketplaces

Mercari, Facebook Marketplace, and Depop ship as assisted handoffs. SnapList may prepare
platform-appropriate text and photos, invoke the native share sheet or an honest deep link when
available, and show a short checklist. The seller completes the destination form. SnapList must not
claim it filled, submitted, or published that listing. Direct automation requires a separately
approved official partner API.

### 7. Information, guidance, and data lifecycle

- Primary navigation is Home, Listings, central Capture, Inbox, and Insights. Account/Settings opens
  from profile. Runs are contextual from Home and persistent processing status.
- The bell opens the complete activity center. Push is limited to draft ready, processing
  failed/needs input, buyer message, sold/order action, expired eBay connection, and failed assisted
  export. Routine stage changes and successful syncs stay in-app.
- Cost basis is optional on the draft and may be requested again when a sale is recorded. Without
  cost, show revenue, estimated fees, and estimated net proceeds, never profit. Adding cost later may
  update profit retroactively.
- Scout guidance is curated, deterministic, localizable, and driven by real state; launch does not
  spend free-form AI on guide copy.
- After a usable guest result exists, encrypted local recovery data and server-side guest artifacts
  remain recoverable for 24 hours. Account claim transfers them; expiry deletes them. Temporary
  processing copies expire after operational recovery needs. Listing/account deletion purges
  associated SnapList data subject to required provider/legal records.

## Implementation owners created from #166

Each gap remains outside this documentation branch and has one narrow owner:

| Issue | Ownership surface                                                     | Project phase |
| ----- | --------------------------------------------------------------------- | ------------- |
| #167  | Reconcile the full native design inventory with this ADR              | Phase 0       |
| #168  | Monthly AI-item credit ledger and usable-draft settlement             | Phase 2       |
| #169  | Post-publish eBay authority, synchronization, and sync conflicts      | Phase 3       |
| #170  | Seller-confirmed launch buyer-message delivery                        | Phase 2       |
| #171  | Deterministic, localizable Scout guidance contract                    | Phase 1       |
| #172  | Recommendation-only stale-inventory repricing                         | Phase 3       |
| #173  | StoreKit-to-server Seller Pro entitlement bridge                      | Phase 2       |
| #174  | App Attest guest allowance and publish-time account claim             | Phase 1       |
| #175  | Encrypted 24-hour guest recovery and expiry                           | Phase 1       |
| #176  | Thin post-sale read model and confirmed add-tracking/mark-shipped     | Phase 3       |
| #177  | Sold-elsewhere record and confirmed verified eBay end-listing         | Phase 3       |
| #178  | Assisted Mercari, Facebook Marketplace, and Depop handoffs            | Phase 3       |
| #179  | Native navigation, contextual Runs, activity center, and bounded push | Phase 2       |
| #180  | Truthful native sale economics with optional cost basis               | Phase 3       |
| #181  | SnapList-owned deletion and temporary-artifact retention              | Phase 4       |

All are `Lane = Blocked` while their declared dependencies remain open. Existing owners #17, #47,
#141, #153, #159, #161, and #162 remain unchanged.

## Consequences

- The native launch value moment and paywall are stable even while legacy web daily-capacity code is
  still being reconciled.
- Credit behavior is testable at a durable business seam rather than inferred from requests or queue
  attempts.
- eBay synchronization and post-sale work require explicit conflict and confirmation models; local
  optimistic state cannot masquerade as provider truth.
- Existing automatic repricing and default-off auto-reply implementation cannot be exposed as native
  launch autonomy. Separate implementation owners must reconcile or disable those paths without
  expanding this documentation PR.
- The current Claude Design handoff matches this ADR. The bundled `FULL-DESIGN-SCOPE.md` still carries
  daily capacity, questionnaire, and older visual assumptions and must be corrected by a separate
  design-inventory owner rather than edited here.

## Official eBay references

- [Sell Fulfillment API](https://developer.ebay.com/develop/api/sell/fulfillment_api)
- [Handling unfulfilled line items](https://developer.ebay.com/api-docs/sell/static/orders/handling-unfulfilled-lineitems.html)
- [Managing Inventory offers](https://developer.ebay.com/api-docs/sell/static/inventory/managing-offers.html)
- [Sell Notification topics](https://developer.ebay.com/develop/api/sell/notification_events)
