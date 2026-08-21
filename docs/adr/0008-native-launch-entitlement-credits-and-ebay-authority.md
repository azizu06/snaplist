# ADR-0008: Lean native launch, entitlement, credits, and marketplace authority

- **Status:** Accepted; lean-MVP scope amended by issues #349/#350
- **Date:** 2026-07-15; amended 2026-07-21
- **Decision owners:** #166 (original native contract), #349 (Scan-to-Trophy-Wall redirection)
- **Preserved dependencies:** ADR-0004, ADR-0007, ADR-0009, ADR-0012

## Context

The original native launch contract expanded into five primary destinations, buyer messaging,
analytics, post-sale operations, barcode and measurement states, and advanced-volume workflows.
Those plans obscured the first-value product and repeatedly authorized work outside the approved lean
MVP.

Issue #349 re-centers SnapList on one observable outcome: one to five photos plus optional short
voice context become a trustworthy, editable, priced listing that reaches the Trophy Wall. This
amendment narrows presentation and launch scope without weakening tenancy, guest authority, durable
processing, credit accounting, coherent review, pricing evidence, or external-side-effect safety.

## Decision

### 1. Scan-to-Trophy-Wall information architecture

The native app has exactly two primary destinations:

1. **Scan** — locally recoverable intake for one physical item with one to five ordered photos and
   zero or one voice note capped at fifteen seconds. Scan clears only after durable server acceptance,
   after which the seller may start another item while accepted work processes asynchronously.
2. **Trophy Wall** — one tenant-owned chronological projection merging local pending intake and
   canonical server identity without duplication. Public states are pending upload, accepted,
   analyzing, ready to review, needs retry, published to eBay, and export pack prepared/shared.

Settings opens from the profile avatar. There is no third primary destination, activity-center
authority, or separate Runs destination. Seller-facing state uses plain language and never exposes
queue, worker, lease, provider, or infrastructure vocabulary. Fake percentages and ETAs remain
prohibited.

Final high-fidelity composition belongs to the redirected design task. This ADR authorizes product
structure, not SwiftUI implementation.

### 2. First value and guest allowance

The first path contains no seller questionnaire, signup wall, or subscription interruption before a
usable draft. One App Attest-backed device entitlement includes:

- one complete AI item run for one immutable photo set;
- exactly one guided identity correction for that same item/photo set; and
- unlimited manual edits that do not change the photo set.

The first usable listing and first seller-confirmed eBay publish are free. Account creation and eBay
connection become blocking only when the guest chooses **Publish to eBay**. Authentication claims and
reopens the same result; it never regenerates the listing as a side effect.

The usable guest result remains encrypted and recoverable for 24 hours. Successful claim transfers
ownership atomically. Expiry or deletion removes guest artifacts under the existing retention and
cleanup contracts. ADR-0012 and `docs/contracts/lean-mvp-retention-v1.json` are the singular
row-level authority for those deletion and retention dispositions.

Adding, replacing, or removing a photo changes the photo set and requires a new run. Reordering is a
request-affecting change and participates in request identity. The one-to-five mobile submission
implementation shipped through #352. Optional voice is separately versioned request input; its
intake and durable pipeline behavior shipped through #351 and #774, including photos-only fallback.

### 3. Usable draft and AI-item credit accounting

A **usable draft** exists only when one coherent item, price recommendation (including an honestly
labeled fallback), and editable listing are durably available. Partial stage output, a queue
acknowledgement, provider success, or an uncommitted listing does not qualify.

The canonical credit lifecycle remains:

- reserve before provider-backed processing;
- settle exactly once at usable draft; and
- restore exactly once after terminal failure/cancellation before usable draft.

Internal model/schema retries, crash recovery, queue redelivery, resumable checkpoints, and the one
included guided correction reuse the same logical run and credit. A new item, changed photo set, or
full re-analysis needs a new reservation. SnapList Pro gates complete AI item run #2 at reservation,
not during capture, editing, saving, or delivery of an existing result.

Monthly Apple products use the verified StoreKit transaction span. Annual products use server-derived
monthly subperiods inside the signed annual span. Verified grace preserves the current remainder
without advancing; late, duplicate, out-of-order, or ambiguous state cannot advance allowance.
RevenueCat may manage client StoreKit lifecycle, but the server ledger remains quota authority.

ADR-0004 operational rate limits remain defense-in-depth. They are not the native product promise.

### 4. Durable processing and tenant authority

The existing Pipeline remains the single analysis path. Supabase Queues carry only the strict
`{ run_id, schema_version }` wake-up envelope. The tenant-owned `pipeline_runs` record owns durable
status, stage, attempts, fencing, recovery, and terminal truth.

Queue claim/ack capability is not domain authority. Every domain table remains tenant-owned through
the Clerk text `user_id`, Postgres RLS, private Storage policies, or audited run-scoped RPCs that
derive ownership from the stored run. The scope reduction does not weaken RLS, App Attest, private
Storage, idempotency, recovery, cleanup, or retention.

Native clients translate server truth into the Trophy Wall public states. They do not implement
entitlement, queue, pricing, provider, or marketplace policy locally.

### 5. Pricing evidence and fail-soft completion

All pricing continues through the provider-neutral `PricingProvider` router. Caffein Apify is the
intended primary automatic `ebay-sold` adapter, but activation remains operator-controlled and gated
by current cost/quality evidence. The public-page adapter remains an immediate fail-soft retrieval
fallback. Both feed the same canonical matcher and neither can post or message.

The intended evidence contract retrieves ten candidates first and expands once to twenty only when
fewer than three trustworthy anchors survive. At most five deterministically ranked, verified sold
matches are persisted/displayed. Results are never padded and the client never reconstructs sold
evidence from generic source URLs.

Provider failure, blocking, or thin evidence never strands an otherwise coherent listing. The draft
completes with `Starting price estimate` and `No verified sold matches found.` when no trustworthy
sold evidence exists. Evidence-backed tiers require citations; only the clearly labeled terminal
fallback may be uncited.

### 6. Review and effective-price authority

Guided identity correction remains bounded and pre-publish. It reruns shared pricing, composite
confidence, and listing generation, then atomically persists the item, eBay draft, and prediction log
under RLS. It preserves a saved seller price override, invalidates stale export packs, rejects stale
or publishing/published state, and never auto-publishes.

A usable, positive, cent-normalized `items.price_override` remains the **effective price** for every
outbound path; otherwise the latest recommendation applies. Price changes advance `review_revision`.
Stale publish/export acquisition fails closed, and prediction logs remain recommendation/evaluation
history rather than seller-price authority.

### 7. eBay and export-pack authority

eBay is the only direct-publish destination. The transactional eBay adapter is the only marketplace
mutation seam. Publish requires claimed account identity, eBay connection, current review acquisition,
explicit seller confirmation, and durable replay protection. SnapList owns unpublished drafts; after
publish, only confirmed provider results become local truth. Conflicts are explicit.

Facebook Marketplace, Mercari, and Depop receive platform-appropriate prepared/shared export packs,
the native share sheet or an honest deep link, and a completion checklist. The seller completes the
destination form. `Prepared` or `Shared` never means `Published`, `Listed`, or `Sold`.

There are no autonomous marketplace actions. Repricing, ending, relisting, fulfillment, post-sale,
and message actions are not launch surfaces in the lean MVP.

### 8. Superseded launch concepts and issue records

The following records remain valuable historical or implementation evidence, but no longer authorize
lean-MVP navigation, design states, acceptance criteria, or new production work. Future triage must
reference #349 and use a separately approved post-MVP issue before reviving any family.

| Rejected lean-launch concept | Superseded records | Current treatment |
| --- | --- | --- |
| Five-tab Home/Listings/Capture/Inbox/Insights navigation and activity center | #204–#215, including #208 and the original native V1 design package | Replaced by Scan + Trophy Wall; Settings from profile avatar |
| Inbox, buyer messaging, buyer-Q&A delivery | #140, #141, #145, #146, #150 and related historical messaging work | Outside lean MVP; historical code is not launch authority |
| Generic analytics, Insights, revenue/profit dashboards, streaks | #118, #220, #274, #289 and original Insights designs | Outside lean MVP |
| Post-sale, fulfillment, sold-elsewhere, repricing, relisting | #169, #172, #176, #177 | Outside lean MVP |
| Bulk/haul capture and triage-list launch posture | #100, #111 and batch surfaces | Outside lean MVP; may be reconsidered only after the one-item path is validated |
| Barcode-only capture UI | original `CAP-05` and related candidate designs | Rejected; passive ISBN/UPC identification hints may remain internal |
| Garment-measurement workflow | #104, #116, #124 and `CAP-08`/`CAP-09` | Outside MVP composition; historical experiment/code may remain until separately retired |
| Autonomous marketplace actions | legacy autopilot/reprice/message concepts | Prohibited; explicit seller confirmation remains mandatory |

Historical migrations must not be rewritten or deleted to enforce this product decision. Obsolete
production composition is removed only through separately scoped expand-contract work after its
replacement is green.

## Consequences

- Agents and designers have one small product authority and cannot infer retired dashboard features
  from historical code or artifacts.
- The expensive safety foundations survive unchanged: RLS tenancy, App Attest guest authority,
  durable recovery, exact credit settlement, coherent review, evidence honesty, effective-price
  precedence, eBay adapter authority, and explicit seller confirmation.
- Product documentation must distinguish shipped intake behavior from any remaining follow-up work;
  it must not retain closed photo-count or voice implementation-gap claims.
- Existing broad modules may remain temporarily, but persistence does not make them launch scope.
- The redirected high-fidelity design package, not the superseded V1 package, will own future SwiftUI
  composition.
