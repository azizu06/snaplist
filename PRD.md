# SnapList — Product Requirements Document

> Status: **Ready for build.** This document is the product source of truth.
> Epic [#349](https://github.com/azizu06/snaplist/issues/349) supersedes earlier launch plans where
> they conflict with this lean MVP. `PROJECT_BRIEF.md` remains historical narrative only.

## Problem Statement

Selling one used item still requires too much fragmented work: take useful photos, identify the item,
research what comparable items actually sold for, write a credible listing, and move the result into
a marketplace. Broad inventory dashboards and seller-operations tooling add navigation and concepts
before SnapList has proved its core value.

The primary user is an average consumer reseller who wants one item converted into a trustworthy,
editable, priced listing with minimal friction.

## Solution

SnapList is a native **Scan-to-Trophy-Wall** product with exactly two primary destinations:

- **Scan** — capture one to five ordered photos and, optionally, one voice note of at most fifteen
  seconds. Submit once; after durable server acceptance, Scan clears so another item can begin while
  processing continues asynchronously.
- **Trophy Wall** — the one chronological place for local pending intake and canonical server truth:
  accepted, analyzing, ready to review, needs retry, published to eBay, and export pack
  prepared/shared. Settings opens from the profile avatar.

The seller receives one coherent, editable listing with identity, condition, copy, price
recommendation, confidence, and honest evidence. The first usable listing appears before signup or a
paywall. eBay is the only direct-publish destination. Facebook Marketplace, Mercari, and Depop receive
honest prepared/shared export packs; SnapList never claims it filled or published their forms.

### Locked lean MVP contract

- Native SwiftUI is the launch client. Primary navigation is exactly **Scan** and **Trophy Wall**;
  Settings opens from the profile avatar.
- Intake contains one to five ordered photos and at most one optional voice note capped at fifteen
  seconds. Voice failure degrades to photos-only processing.
- Processing is asynchronous. Seller-facing states use plain language and never expose queues,
  workers, leases, fake percentages, or provider internals.
- First value precedes account creation and subscription interruption. One App Attest-backed guest
  allowance produces one complete usable listing and includes one guided identity correction for the
  same immutable photo set. The result remains encrypted and recoverable for 24 hours.
- SnapList Pro gates complete AI item run #2 at the canonical reservation boundary. Technical retries,
  recovery, and queue redelivery reuse the same logical run and credit.
- RLS tenant isolation, private Storage, durable pipeline/recovery, AI-item credit settlement,
  effective-price precedence, coherent correction, revision guards, and deletion/retention contracts
  remain authoritative.
- Apify is the intended primary automatic sold-comp adapter behind an operator-controlled activation
  gate. Its output is untrusted until the provider-neutral matcher accepts it. Provider failure or
  insufficient evidence fails soft to a complete editable draft with honest estimate language.
- eBay mutations only pass through adapter interfaces. SnapList owns unpublished drafts; confirmed
  eBay results become authoritative after publish. Every marketplace action requires explicit seller
  confirmation and replay protection.
- Facebook Marketplace, Mercari, and Depop are assisted export-pack destinations only. `Prepared` or
  `Shared` never means `Published`, `Listed`, or `Sold`.
- Inbox, buyer messaging, generic analytics, post-sale operations, barcode-only capture, garment
  measurements, bulk/haul launch posture, and autonomous marketplace actions are outside this MVP.
  Historical implementations may remain until separately retired, but they are not product authority
  or permission for new launch work. See ADR-0008.

## User Stories

1. As a seller, I want to start in Scan without a questionnaire, signup, or paywall, so that I reach
   value immediately.
2. As a seller, I want to add, replace, remove, and reorder one to five photos, so that I control the
   item evidence before submission.
3. As a seller, I want to optionally record, replay, replace, or delete one voice note of at most
   fifteen seconds, so that I can add context without typing.
4. As a seller, I want unfinished intake to survive interruption, so that capture work is not lost.
5. As a seller, I want ambiguous submission to retain the intake and logical request identity, so
   that retry cannot duplicate the item.
6. As a seller, I want Scan to clear only after durable acceptance, so that I can safely begin another
   item while the accepted item processes asynchronously.
7. As a seller, I want Trophy Wall to merge local pending intake with canonical server IDs without
   duplication, so that there is one truthful place to return.
8. As a seller, I want progress described as accepted, analyzing, ready to review, or needs retry, so
   that infrastructure vocabulary never leaks into the product.
9. As a first-time seller, I want one complete usable listing from my own item before signup or
   paywall, so that I can judge real value.
10. As a seller, I want optional voice failure to fall back to photos-only processing, so that an
    enhancement cannot strand the item.
11. As a seller, I want spoken details treated as seller context rather than verified evidence, so
    that the listing does not silently overstate certainty.
12. As a seller, I want an editable title, description, item specifics, condition, price, confidence,
    and evidence state, so that the output is useful without another tool.
13. As a seller, I want up to five trustworthy sold matches drawn from the same canonical matcher used
    by pricing, so that the recommendation is explainable.
14. As a seller, I want the listing to complete when trustworthy sold matches are unavailable, with
    `Starting price estimate` and `No verified sold matches found.`, so that uncertainty is honest.
15. As a seller, I want identity correction to re-price and regenerate coherently while preserving my
    saved price override, so that stale facts never mix.
16. As a seller, I want my effective price to govern eBay publish and every export pack, so that no
    delivery path uses an old recommendation.
17. As a seller, I want Publish to eBay to request account creation, eBay connection, and explicit
    confirmation only at delivery time, so that first value remains frictionless.
18. As a seller, I want eBay publish to be exact-once and provider-authoritative, so that retry cannot
    create duplicate external actions.
19. As a seller, I want prepared/shared export packs for Facebook Marketplace, Mercari, and Depop, so
    that unsupported destinations remain useful without false publishing claims.
20. As a seller, I want Settings available from my profile avatar, so that account and product controls
    remain accessible without becoming a primary destination.
21. As a seller using assistive technology or Reduced Motion, I want every state and action to remain
    understandable without animation, so that polish never becomes a barrier.

## Implementation Decisions

### Intake and asynchronous processing

- Intake is a locally recoverable request containing one to five ordered photos and zero or one
  bounded voice asset. The verified photo-set identity remains the authority for guest allowance and
  guided correction; the full request fingerprint also covers ordered inputs and voice identity.
- Raw voice is temporary processing input. A bounded transcript may persist as seller context and
  follows item/account deletion. It cannot override image, catalog, sold-evidence, or marketplace
  truth. Issue #351 owns the behavior contract; this PRD does not implement it.
- The existing durable Pipeline remains the only analysis path. Supabase Queues carry the strict
  `{ run_id, schema_version }` wake-up envelope; the tenant-owned `pipeline_runs` record is product
  truth. Queue authority is not tenant-domain authority.
- Seller-facing clients map durable truth to plain-language Trophy Wall states. They do not display
  queue terms or fabricate progress.
- Issue #352 owns the mobile one-to-five submission behavior. Until it lands, older API limits are an
  implementation gap, not product authority.

### Tenancy, guest authority, and credits

- Every tenant domain row carries the Clerk `user_id`; Postgres RLS and private Storage policies
  enforce isolation. Worker access derives ownership from the stored run through RLS or audited,
  run-scoped RPCs.
- One App Attest-backed guest allowance includes one complete AI item run and one guided correction
  for the unchanged photo set. The usable result remains encrypted and recoverable for 24 hours,
  after which it is claimed or deleted.
- Reserve an AI-item credit before provider-backed processing, settle exactly once at **usable draft**,
  and restore exactly once after failure/cancel before that point. Run #2 is the first paid gate.
- Manual edits that preserve the immutable photo set, internal retries, recovery, and queue redelivery
  do not spend another credit. A new item, changed photo set, or full re-analysis does.

### Deletion and retention

- `docs/contracts/lean-mvp-retention-v1.json` is the singular row-level authority for every release
  datum's owner, deletion triggers, maximum retention, executor, and completion proof. ADR-0012
  explains the policy and preserves unresolved legal or provider obligations as release blockers.
- Raw seller voice is temporary private processing input. Delete it after the first durable terminal
  transcription outcome and never later than 24 hours after durable acceptance. A retained transcript
  follows the voice context, item, guest-claim/expiry, and account deletion lifecycle instead.
- Account erasure cannot claim completion while the matrix has an unresolved disposition or while an
  executor lacks its named completion proof. Provider-owned deletion is not SnapList deletion.

### Pricing, evidence, and listing generation

- All pricing routes through `PricingProvider`: structured ISBN lookup → eBay sold comps → cited web
  search → depreciation → clearly labeled LLM-only fallback.
- Caffein Apify is the intended primary automatic `ebay-sold` adapter, but activation is an
  operator-controlled configuration decision gated by current cost/quality evidence. Direct public
  sold-page retrieval remains a fail-soft fallback. Both use the same canonical matcher.
- Retrieve ten sold candidates first and expand once to twenty only when fewer than three trustworthy
  anchors survive. Persist/display at most five deterministically ranked verified matches; never pad.
- Evidence-backed tiers cite sources. When no trustworthy sold evidence exists, complete the editable
  draft with the exact honest no-evidence language rather than failing the run.
- Confidence is a composite of tier trust, comp agreement, and identification completeness. Raw model
  self-report never authorizes an action.
- Structured model output uses the role-keyed provider registry, Vercel AI SDK, and Zod. Optional
  listing-example retrieval is evaluation-gated, default-off, and never pricing or factual authority.

### Review and delivery

- A usable draft is one coherent item, price recommendation, and editable listing durably available.
  Guided identity correction reruns shared pricing/confidence/generation and atomically persists the
  coherent result under RLS.
- A valid cent-normalized `items.price_override` wins over recommendation history everywhere. Price
  changes advance `review_revision`; stale publish/export work fails closed.
- The eBay transactional adapter is the only direct marketplace mutation seam. Account claim,
  connection, review snapshot acquisition, explicit seller confirmation, provider result, and durable
  replay protection are required.
- Facebook Marketplace, Mercari, and Depop receive platform-appropriate text/photos via a native
  share sheet or honest deep link plus a completion checklist. The seller finishes the form.

### Information architecture

- Primary destinations are exactly **Scan** and **Trophy Wall**. Settings opens from the profile
  avatar. No third primary tab or activity center may be inferred.
- Trophy Wall is a compact chronological projection, not an inventory analytics, messaging, order,
  fulfillment, or performance dashboard.
- Scout may provide quiet, state-bound, deterministic guidance. It cannot fabricate progress, block
  actions, or replace a static Reduced Motion fallback.

## Testing Decisions

- Test external behavior at the highest stable seam; do not assert implementation details.
- Documentation and design contracts must parse, link correctly, and agree on the locked decisions.
- Intake behavior tests owned by #351/#352 cover one and five photos, zero/six rejection, ordering,
  optional voice limits/fallback, relaunch recovery, ambiguous retry, and exact replay.
- Pipeline tests preserve RLS tenancy, durable recovery, credit settlement/restoration, and coherent
  completion without garment-measurement composition.
- Pricing tests cover conditional retrieval expansion, maximum five verified matches, deterministic
  ranking, canonical evidence parity, and complete draft generation with no trustworthy comps.
- Trophy Wall tests cover tenant isolation, deterministic local/server merge, truthful state
  convergence, retry visibility, progressive disclosure, accessibility, and honest export wording.
- Marketplace tests use mock adapters to prove explicit confirmation, exact-once eBay mutation, and
  that prepared/shared export packs never become direct publish claims.

## Out of Scope

The following are explicitly rejected from the lean MVP and must not be recreated by triage or design
inference. Historical code and migration records may remain until separately retired.

- Inbox, buyer messaging, buyer-Q&A delivery, or an activity-center feed.
- Generic analytics, revenue/profit dashboards, streaks, and gamified performance graphs.
- Post-sale order, payment, fulfillment, shipping, returns, cancellations, disputes, repricing,
  relisting, or sold-elsewhere workflows.
- Bulk/haul capture as a launch posture.
- Barcode-only capture or a separate barcode UI. Passive ISBN/UPC recognition may remain an internal
  identification hint without adding a user state.
- Garment-measurement capture or extraction in the MVP composition.
- Autonomous publish, reprice, end, relist, fulfill, or message actions.
- Direct form filling or publishing to Facebook Marketplace, Mercari, or Depop.
- Mandatory voice, five photos, five comps, fake comp data, or raw comp averaging.
- RAG as a launch dependency or native product state.
- Production provider activation, hosting migration, credentials, or deployment through a
  documentation change.
- Final high-fidelity composition; the redirected design task owns it.

ADR-0008 records the superseded issue families so future planning does not treat old implementation
or design records as launch authority.

## Further Notes

- Existing expensive foundations are redirected, not rewritten. Expand-contract changes must keep
  main green before obsolete production code is removed by separately scoped issues.
- Security, RLS, guest authority, credits, durable processing, pricing evidence, eBay adapter
  boundaries, and export-pack honesty survive the scope reduction.
- Backend and contract work may proceed only through its owning issue. SwiftUI implementation waits
  for the redirected, versioned high-fidelity design package.
