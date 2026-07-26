# SnapList — Domain Context & Glossary

This is the shared vocabulary for the lean MVP. `PRD.md` owns requirements; ADR-0008 owns the
durable entitlement, marketplace-authority, and supersession decisions.

## What the product does

A seller uses **Scan** to submit one to five photos and optional short **voice context**. SnapList
asynchronously identifies the **Item**, finds trustworthy **sold comps** when available, produces a
user-editable **price recommendation** and **Listing**, and returns truthful progress and outcomes to
the **Trophy Wall**. The first usable listing precedes signup/paywall. eBay is the only direct-publish
destination; Facebook Marketplace, Mercari, and Depop receive honest **export packs**.

## Lean MVP language

- **Seller** — the SnapList user. The only human actor in the native product.
- **Scan** — one of exactly two primary destinations. It owns recoverable intake for one physical
  item: one to five ordered photos and zero or one voice note capped at fifteen seconds. It clears
  only after durable server acceptance.
- **Trophy Wall** — the other primary destination. A tenant-owned chronological projection that
  merges local pending intake with canonical server truth without duplication. Its public states are
  **pending upload**, **accepted**, **analyzing**, **ready to review**, **needs retry**, **published to
  eBay**, and **export pack prepared/shared**. It is not an analytics, messaging, inventory, order, or
  fulfillment dashboard.
- **Settings** — the full account/product-control destination opened from the profile avatar. It is
  not a third primary destination.
- **Voice context** — optional seller-supplied context from at most one fifteen-second voice note.
  Raw audio is bounded temporary input; a transcript may enrich condition notes or listing copy but
  is not external verification and cannot override image, catalog, sold-evidence, or marketplace
  truth. Missing/failed voice processing falls back to photos only.
- **Item** — one physical thing the seller wants to sell. The root entity with photos, extracted
  **attributes**, a **condition**, and eventually a **price recommendation**.
- **Attributes** — Zod-validated facts extracted from photos: brand, model, category, key specs, and
  any passively decoded ISBN/UPC. Prefer “attributes” over “metadata” or “details.”
- **Condition** — the assessed wear state of an item. Prefer “condition” over “quality.”
- **ISBN / UPC** — passive identification aids. ISBN may resolve structured catalog identity; UPC
  may sharpen search. Neither creates a barcode-only Scan mode, and UPC is never a price source.
- **Listing** — coherent, editable sale copy for one item: title, item specifics, description,
  condition, photos, and effective price. The lean MVP produces an eBay draft plus supported export
  packs.
- **Usable draft** — the AI-item settlement point: one coherent item, price recommendation (including
  an honestly labeled fallback), and editable listing are durably available. Provider output,
  partial checkpoints, or queue acknowledgement alone do not qualify.

## Pricing and evidence

- **PricingProvider** — the interface every pricing strategy implements. Never bypass it with an
  inline price lookup.
- **Tier** — one pricing strategy in order: structured ISBN lookup → **eBay sold comps** → cited web
  search → depreciation → clearly labeled LLM fallback. Which tier fired is logged.
- **eBay-sold adapter** — read-only sold-price research, distinct from the transactional eBay
  **adapter**. Caffein Apify is the intended primary automatic adapter behind an operator-controlled
  activation gate; the public-page provider is the immediate fallback. Both feed the same canonical
  matcher and fail soft when blocked or too thin.
- **Comp** — a comparable price point. A **sold comp** is a verified completed sale; an **asking comp**
  is an active listing and is weaker evidence. Never represent an asking price as a sold amount.
- **Price recommendation** — `{ suggested, range, confidence, sources[] }`, always editable.
  Evidence-backed tiers cite sources. The terminal `llm-only` estimate may be uncited and must be
  labeled honestly.
- **Pricing-evidence snapshot** — the immutable tenant-scoped recommendation and verified sold comps
  committed with one successful pipeline run at one server `evidenceAsOf` time. Clients consume the
  whole snapshot; they do not reconstruct it from generic URLs or combine runs.
- **No-evidence result** — a complete editable draft with `Starting price estimate` and
  `No verified sold matches found.` It is a valid fail-soft result, not a stranded pipeline run.
- **Confidence** — a composite of tier trust, comp agreement, and identification completeness.
  Never raw model self-report and never authorization for a marketplace action.
- **Effective price** — a valid positive cent-normalized seller `price_override`; otherwise the
  latest recommendation. It governs eBay publish and every fresh/cached export pack.
- **Prediction log** — per-run evaluation history containing attributes, price, range, confidence,
  tier, and model. It is not the seller’s chosen price or a delivery authority.

## Durable value, tenancy, and credits

- **Pipeline run** — the tenant-owned durable execution record for one listing-preparation attempt.
  It owns status/stage/attempt/idempotency/recovery truth. Seller UI maps it to plain language and
  never exposes queue, worker, lease, or provider terminology.
- **Pipeline queue envelope** — internal `{ run_id, schema_version }` wake-up data. It contains no
  photo URL, tenant claim, secret, seller copy, or authorization. It is never seller-facing.
- **AI-item credit** — one logical entitlement reservation for one complete run. Reserve before
  provider work, settle once at usable draft, and restore once on failure/cancel before that point.
  Internal retries, recovery, queue redelivery, and the included guided correction reuse it.
- **Guest allowance** — one App Attest-backed device entitlement with one AI-item credit and one
  guided correction for the same immutable photo set. The usable result is encrypted/recoverable for
  24 hours and then claimed or deleted.
- **Review correction** — bounded pre-publish replacement of identity facts followed by shared
  pricing/confidence/listing regeneration and one atomic RLS-scoped persistence step. It preserves a
  seller price override and never publishes.
- **Review revision** — the item-owned concurrency token covering review edits, regeneration, export
  packs, and publish acquisition. Stale writers fail closed.
- **Tenant isolation** — every domain row is owned by a Clerk `user_id`; Postgres RLS and private
  Storage policies enforce isolation. Queue authority never substitutes for tenant authority.

## Marketplace delivery

- **eBay connection generation** — a reconnect-sensitive identifier for the current encrypted OAuth
  grant. It advances whenever the seller replaces that grant, even when they reconnect the same eBay
  identity. Read-only discovery and later marketplace work use it to reject results produced by an
  earlier connection.
- **eBay policy/location binding** — the connected seller's fulfillment, payment, and return policy
  choices plus enabled inventory location for one eBay marketplace and one eBay connection
  generation. A unique usable choice may bind automatically; otherwise the binding remains
  **setup required** or **selection required**. Candidate labels never include addresses, phone
  numbers, seller descriptions, or other provider-private details.
- **Adapter** — an isolating interface around an eBay capability. The transactional eBay adapter is
  the only direct marketplace mutation seam and must remain testable against mocks.
- **Publish** — putting a listing live on eBay after account claim/connection, current review
  acquisition, and explicit seller confirmation. Durable replay protection prevents duplicates.
- **eBay authority** — SnapList owns unpublished drafts. After publish, only confirmed provider
  results become local truth; conflicts are explicit rather than silent last-write-wins.
- **Export pack** — platform-appropriate text/photos for Facebook Marketplace, Mercari, or Depop.
  It is delivered through a native share sheet or honest deep link plus a completion checklist. It
  never directly fills or publishes a destination form.
- **Prepared / Shared** — export-pack delivery states. Neither means `Published`, `Listed`, or `Sold`.
- **Explicit seller confirmation** — the mandatory authorization for every external marketplace
  mutation. Confidence, eligibility, automation, or a retry can never substitute for it.

## Retired launch language

The following terms may occur in historical code, migrations, benchmarks, or closed issue records.
They are outside the lean MVP and must not be used to create new launch states, navigation, or
acceptance criteria. ADR-0008 records the superseded issue families.

- **Inbox / buyer messaging / buyer-Q&A delivery** — not a primary destination or lean-MVP flow.
- **Insights / generic analytics / profit dashboard / streaks** — not a primary destination or
  lean-MVP motivation system.
- **Post-sale operations** — order, fulfillment, shipping, returns, cancellations, disputes,
  repricing, relisting, and sold-elsewhere workflows are deferred.
- **Bulk / haul capture and triage list** — historical advanced-volume behavior, not launch posture.
- **Barcode-only capture** — rejected. Passive ISBN/UPC recognition may remain internal only.
- **Garment measurements** — historical experiment/implementation, excluded from MVP composition.
- **Autonomous marketplace action** — prohibited. No publish, reprice, end, relist, fulfill, or
  message action may occur without explicit seller confirmation; only direct eBay publish is in the
  lean MVP.

## Terms to avoid

- “Home,” “Listings,” “Inbox,” or “Insights” as primary native destinations → use **Scan** and
  **Trophy Wall**.
- “Queued,” “worker,” “lease,” or provider names in seller-facing progress → use the Trophy Wall
  public states.
- “Published” for Facebook Marketplace, Mercari, or Depop → use **export pack prepared/shared**.
- “The model’s confidence” when referring to the composite → use **confidence**.
- “Buyer” as a SnapList actor → only the **seller** uses SnapList in this MVP.

## Builder

- **Builder** — Aziz, operating and shipping SnapList as a real product while preserving its
  evidence-driven engineering narrative.
