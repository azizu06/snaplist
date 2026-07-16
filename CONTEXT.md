# SnapList — Domain Context & Glossary

The shared vocabulary for this repo. Use these exact terms in code, issues, tests, and PRDs. Full
requirements live in `PRD.md`; this file is the language layer the engineering skills read first.

## What the product does (one paragraph)
A seller photographs a used item; SnapList **identifies** it, **prices** it with a range and a
**confidence** score, cites the evidence-backed tiers, and clearly labels the terminal uncited
fallback when necessary. It **generates** platform-specific listing copy and **drafts**
buyer replies. The confidence gate can mark high-confidence items **ready to publish**; the seller
still confirms every consequential eBay action through an **adapter**. Other launch platforms
receive honest **assisted marketplace handoffs**.

## Glossary (ubiquitous language)

- **Item** — a single physical thing the seller wants to sell. The root entity. Has photos, extracted
  **attributes**, a **condition**, and (once priced) a **price recommendation**.
- **Attributes** — the structured, Zod-validated facts extracted from photos: brand, model, category,
  key specs, and any decoded **barcode**/**ISBN**. Prefer "attributes" over "metadata" or "details".
- **Condition** — the assessed wear state of a used item (e.g. new/like-new/good/fair). A first-class
  attribute because it drives pricing. Not "quality".
- **Barcode / ISBN / UPC** — *ISBN* (books/media) resolves to a structured catalog lookup; without
  sold grounding its pricing trust remains estimate-level. *UPC*
  (general goods) is decoded only as an **identification aid** that sharpens the search, never a price
  source. "Barcode" is the umbrella term.
- **PricingProvider** — the interface every pricing strategy implements. Returns a **price
  recommendation**. Never bypass it with an inline price lookup.
- **Tier** — one PricingProvider strategy in the routing pipeline: *ISBN lookup* → *eBay sold comps*
  → *web-search agent* → *depreciation estimate* → *LLM fallback*. "Which tier fired" is a logged,
  confidence-bearing fact.
- **eBay-sold scraper** — the `ebay-sold` tier (ADR-0001): reads eBay's PUBLIC sold/completed pages
  (`LH_Sold=1&LH_Complete=1`) for real **sold comps**. Read-only price research — distinct from the
  transactional eBay **adapter** (posting/messaging). Never used to post. Availability is
  best-effort; blocked or too-thin results decline to the next tier.
- **Sold-comps egress** — the outbound fetch path for the **eBay-sold scraper**. Direct HTTPS fetch
  is the default. An operator may configure one validated `EBAY_SOLD_PROXY_TEMPLATE` for hosted
  environments; malformed templates fail before egress, and credentials/raw upstream errors are
  redacted from reports and diagnostics. See `docs/sold-comps-egress.md`.
- **Pricing (research) agent** — the bounded tool-calling **agent** that searches the web for
  used/resale comps and synthesizes a cited range. One of two agents in the system.
- **Comp** — a comparable price point found for an item. A **sold comp** is a completed sale (eBay
  public sold pages, the `ebay-sold` tier) — the strongest used signal; an **asking comp** is an
  active listing (open-web, the web-search tier) and is down-weighted. **Comp agreement** (tight vs
  scattered) is a confidence signal.
- **Price recommendation** — always `{ suggested, range, confidence, sources[] }`, always
  user-editable. Never a bare number. Evidence-backed tiers require citations; the clearly labeled
  terminal `llm-only` estimate may have an empty `sources[]`.
- **Cost basis (COGS)** — what the seller **paid** for the item (cost of goods sold), captured
  optionally at upload or review. Blank means *unknown* (stored `NULL`, never a fake $0); a recorded
  **$0** is a real value (a free find). Persisted as `items.cost_basis`; feeds **net profit**.
- **Net profit (margin)** — the estimated amount a seller pockets on a sale:
  `price − estimated platform fees − cost basis`. Resellers think in margin, not list price, so it's
  shown only when cost basis is known. When cost is missing, show revenue, estimated fees, and
  estimated net proceeds—never profit and never a fake $0. Pure, unit-tested math in
  `src/lib/pricing/fees.ts`.
- **Platform fees** — the per-platform selling-fee **estimate** (`rate × price + fixed`) behind
  net-profit math: eBay ≈13.25% + $0.30, Facebook Marketplace 5%, Mercari ≈12.9% + $0.50. Always an
  *estimate* (labeled "est."), not an invoice — real fees vary by category, store level, and promos.
- **Confidence (composite)** — a signal-based score from {tier fired, comp agreement, identification
  completeness}. Never raw LLM self-report. Drives the **publish-eligibility gate**. The tier-trust ordering
  encodes "sold beats asking": a tight **sold**-comp cluster ranks above the asking-based web tiers
  and below only a sold-backed exact ISBN result (issue #60); a catalog-only ISBN result stays at
  estimate-level trust, and a scattered sold set degrades to the wide-comp tier so a noisy sale
  spread cannot ride the sold label past the gate.
- **Publish eligibility** (persisted under the legacy `autopilot_*` names) — the confidence-gated
  readiness preference: high-confidence items are marked **ready to publish**; lower-confidence
  items stay in review. Toggleable off. Eligibility never calls the eBay **adapter** or publishes in
  the background; only the seller's explicit **Publish to eBay** action creates a marketplace post.
  A seller-triggered **review correction** always returns to `draft`, regardless of score.
- **Bulk / haul capture** — an advanced-volume growth path (issue #100) at `/batch`: photograph
  several items in one session (1–4 photos each), then submit the whole **batch**. Each item runs
  through the *same* single-item pipeline spine (`POST /api/batch/item`) with its own **AI-item
  credit**, evidence, review, and bounded concurrency. Additive to the primary one-item native path,
  never the default posture or a shared-credit shortcut.
- **Triage list** — the live results surface of a bulk **batch**: one row per captured **item**, each
  showing a **triage status** (processing → needs-review / ready-to-publish / active, plus failed /
  credit-limit). Triage statuses are a *reading* of the item's persisted **listing** status — no new
  persisted vocabulary — and the list polls `GET /api/batch/status` so rows track DB truth (e.g. a
  `queued` listing becoming `published` after the seller acts elsewhere). Every row links to the
  item's normal review page.
- **Listing** — generated, platform-specific sale copy for an item (title, item specifics,
  description, tags). One **Item** can have multiple listings (one per platform).
- **Review correction** — the bounded, pre-publish replacement of load-bearing identity facts
  (brand, model, category, condition, valid ISBN/UPC, and relevant specifications), followed by an
  explicit re-price and regeneration through the shared router, confidence, and listing seams. It
  preserves a seller's saved price override and never auto-publishes. Distinct from **Sharpen**,
  which only adds pricing detail and does not regenerate listing copy.
- **Review revision** — the item-owned concurrency token coordinating review edits, regeneration,
  export-pack generation, dashboard edits, applied reprices, and publish acquisition. Any seller-price
  change advances it; stale writers fail rather than mixing identity, price, copy, or marketplace state.
- **Export pack** — platform-appropriate listing text/photos for a platform with no approved write API
  (Facebook Marketplace, Mercari, Depop). It feeds an **assisted marketplace handoff** and is distinct
  from a real **post**. Generated copy is tied to the review content revision, while
  every fresh or cached read carries the current **effective price** and verifies the full review
  revision. Content edits regenerate copy; price-only edits reuse copy without serving a stale price.
- **Assisted marketplace handoff** — prepare Facebook Marketplace, Mercari, or Depop text/photos,
  invoke the native share sheet or an honest deep link when available, and show a short checklist.
  The seller completes the destination form; SnapList never claims it filled or published it.
- **Effective price** — the one amount every outbound consumer uses: a valid, positive,
  cent-normalized seller `price_override`, otherwise the latest suggested price from the prediction
  log. Invalid legacy overrides are ignored rather than published; the underlying recommendation log
  remains unchanged when the seller chooses a different price.
- **Post / publish** — actually putting a listing live on eBay via the **adapter**, always after an
  explicit seller confirmation.
- **eBay authority** — SnapList owns unpublished drafts. After publish, eBay is authoritative for
  listing and order truth. External changes sync into SnapList; seller-confirmed local changes go
  through an **adapter** and persist from the confirmed provider result. Divergence creates a visible
  **sync conflict**, never silent last-write-wins.
- **Sync conflict** — an explicit state where local seller intent and current eBay truth differ or
  provider acknowledgement is ambiguous. SnapList shows both sides and a safe next action rather
  than choosing a winner silently.
- **Adapter** — an isolating interface around an eBay capability such as publish/listing mutation,
  fulfillment, or messaging. Launch flows must run against **mock adapters** with no live eBay.
  Sandbox→production is a credential/configuration flip.
- **Marketplace messaging adapter** — the provider-neutral seam for fetching unresolved pre-sale
  questions, resolving their provider conversation, replying to the exact question, and sending a
  later seller-authored follow-up. Both delivery paths can carry supported hosted photos with the
  required text. Distinct from both the transactional publish adapter and the public
  **eBay-sold scraper**.
- **Message attachment** — a tenant-scoped photo on an imported buyer question or an approved
  seller reply/follow-up. Outbound originals stay in private storage; provider-hosted references
  share the message's delivery truth and never downgrade a failed text-plus-photo attempt to
  text-only success. See `docs/ebay-messaging-sandbox.md` for the provider contract and limits.
- **External question identity** — the identity bundle kept on an imported eBay question: the exact
  Trading `Question.MessageID` used as `ParentMessageID`, plus separate Commerce conversation,
  listing, and buyer identities. These values are not interchangeable.
- **eBay account generation** — the tenant-bound version of a connected or operator-fallback seller
  identity. Sync, messages, token refresh, and provider dispatch are pinned to it so disconnect,
  reconnect, replacement, or erasure cannot let stale work cross account boundaries.
- **Delivery truth** — the external state of a seller-approved reply/follow-up: `sending`, `delivered`,
  `rejected`, `failed`, or `ambiguous`. `sent_at` and an external delivery ID exist only after an
  acknowledgement; ambiguous delivery remains visibly retryable with an explicit duplicate-risk
  confirmation.
- **Inbox sync** — the shared foreground/cron service that reads overlapping eBay windows, stores
  unresolved conversation matches for later reconciliation, deduplicates external identity,
  routes each question once per **message policy version**, and retires questions eBay reports as answered or no
  longer available. Normal ingestion targets the next five-minute boundary or sooner.
- **Safe buyer auto-reply** — the legacy name for a default-off implemented capability. It is not
  authorized in the native launch contract: a deterministic **message policy** may recommend or
  draft an exact restatement of a current authoritative listing fact, but every external send still
  requires explicit seller confirmation. Negotiation, commitments, post-sale support, untrusted
  buyer instructions/premises, raw vision guesses, and missing/stale/conflicting facts remain
  seller-gated.
- **Message policy decision** — the versioned, once-per-question audit outcome: **draft for
  approval** or **escalate**, with structured reasons, grounding references, safety signals, and
  canonical delivery truth. Existing `auto-send` records are legacy state, not launch authorization.
  Model confidence never authorizes a send.
- **Buyer-Q&A agent** — the **agent** that drafts replies to buyer questions, grounded in an item's
  attributes/listing. It runs for simulated demo questions and tenant-scoped eBay Sandbox imports;
  it never authorizes a send. The deterministic **message policy** selects draft or escalation, and
  every authenticated delivery requires explicit seller approval.
- **Inbox** — the seller's live view of simulated or imported buyer **messages**, fed
  DB→Supabase Realtime after **inbox sync**. The seller is the only SnapList user; buyers stay on eBay.
- **Reference corpus** — the seeded set of example items/listings embedded in **pgvector**, used to
  ground listing generation (few-shot) and to *corroborate* pricing. Never the price oracle.
- **Freshness** — sold prices drift, so pricing is **live-fetched** at query time; a TTL
  cache-on-miss + recency/age-decay layer (#59) cuts footprint without becoming the authority. The
  **reference corpus** never serves a stored price as current truth.
- **Prediction log** — the per-run record (attributes, price, range, confidence, tier, model) written
  for every pipeline execution. Its price is the pipeline's recommendation, not a seller override or
  necessarily the outbound **effective price**. The **eval harness** depends on that distinction.
- **Pipeline run** — the tenant-owned durable execution record for one complete listing-preparation
  attempt. It links the seller's **Item** and eventual **Listing**, records status/stage, attempts,
  idempotency, lease fencing, cumulative stage checkpoints, safe failure details, and lifecycle
  timestamps, and is the product-visible truth when queue delivery is retried. Distinct from a
  **prediction log**, which records model/eval output.
- **Usable draft** — the durable settlement point for one complete AI item run: one coherent item,
  price recommendation (including an honestly labeled fallback), and editable listing draft are
  atomically available to the seller. Provider retries, queue attempts, and partial checkpoints do
  not qualify.
- **AI-item credit** — one logical entitlement reservation for one complete AI item run. It is
  reserved before provider-backed processing, settles exactly once at **usable draft**, and is
  restored exactly once after failure/cancellation before that point. Internal retries/recovery and
  the one included same-item/same-photo-set guided correction reuse it; a new item, changed photo set,
  or full re-analysis needs a new credit.
- **Guest allowance** — one App Attest-backed device entitlement containing one **AI-item credit** and
  exactly one guided identity correction for the same item/photo set. Manual edits are unlimited.
  The usable result remains encrypted/recoverable for 24 hours, then is claimed by an account or
  deleted with its server-side guest artifacts.
- **Pipeline queue envelope** — the strict versioned PGMQ message `{ run_id, schema_version }`. It is
  only a wake-up signal: never a photo/signed URL, tenant identity, secret, seller copy, or
  authorization claim. The worker derives tenant scope from the stored **pipeline run**.
- **Eval harness** — the offline quality measurement over a fixed **gold set**: ID accuracy,
  pricing-within-band, **confidence calibration**, listing quality (validated LLM-judge). The
  judge is **cross-family** (`--real-judge` runs the OPPOSITE provider from the generator, #61) to
  strip same-family self-bias; it falls back to the offline heuristic — and says so — when the
  opposite provider's key is absent.
- **Gold set** — the fixed, labeled set of items used by the eval harness; doubles as the demo set.
  Truth is **independent of the pipeline**; price bands are (re)built from live eBay sold comps by
  `pnpm eval:build-gold` (#61), emitted for a human spot-check rather than auto-overwriting.
- **Hero domain** — the item categories SnapList excels at, i.e. reseller inventory (books/media,
  electronics, video games and consoles, board games, LEGO, sneakers, branded clothing/streetwear,
  branded gear) — exactly where eBay public sold comps are dense. Generic items still flow through
  but honestly show low confidence.

## Terms to avoid
- "metadata" → use **attributes**. "quality" (of an item) → use **condition**. "the model's
  confidence" when meaning self-report → say so explicitly; default **confidence** means the composite.
- "chat" / "conversation platform" → SnapList is a seller **control surface**, not a chat app.

## Actors
- **Seller** — the SnapList user. The only human in the app.
- **Buyer** — a person on eBay asking questions. Never a SnapList user.
- **Builder** — Aziz, operating the project as a portfolio/showcase (eval, architecture, narrative).
