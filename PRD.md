# SnapList — Product Requirements Document

> Status: **Ready for build.** Supersedes the decision-open parts of `PROJECT_BRIEF.md`.
> The brief remains the narrative/origin record; this PRD is the source of truth for what we build.
> Working name; idea origin: Ideabrowser "Home Sale Helper" #1613.

---

## Problem Statement

Selling even one used item creates too much work. An average consumer reseller clearing a closet,
selling a hobby item, or building a small side income has to: photograph it, research
what it actually *sold* for used (not retail, not the optimistic asking price), write a competent
platform-appropriate listing, post it, and then answer the same buyer questions over and over.
That is ~20–30 minutes of low-value labor per item, and the pricing research is the worst of it.
Real completed-sale prices are tedious to dig out and retail prices are misleading for used goods.
Existing
cross-listing tools (Vendoo, List Perfectly, Crosslist) copy a listing across marketplaces but
still make the seller do the identification, the pricing, and the writing by hand.

The **primary user is the average consumer reseller**. The launch flow is tuned for a person who
wants one item identified, priced, drafted, and published with clear human control. Advanced
bulk/haul and volume workflows remain a growth path, not the default product posture.

(Framing note: this is built as a **production-real AI-engineering showcase**. The primary success
metric is demonstrating the full AI stack end-to-end in a polished, deployed app — not user growth.
Market saturation is explicitly irrelevant.)

## Solution

SnapList turns a **photo of a resale item** into a **priced, ready-to-post listing**, and drafts
buyer-message replies — collapsing the per-item work into a photo plus a few explicit approvals.

The seller snaps 1–4 photos. The system identifies the item (brand, model, category, condition,
specs, and any barcode/ISBN), researches a defensible price range from **real sold comps when
available**, cited web or depreciation evidence when those tiers resolve, or a clearly labeled
terminal LLM-only estimate that may be uncited, then generates platform-specific listing copy and
shows it for review/edit. The confidence gate marks high-confidence items **ready to publish** and
sends lower-confidence ones to review; eligibility never causes a marketplace mutation. eBay is the
only direct launch integration, and every publish, listing change, fulfillment write, end-listing
action, and buyer-message send requires explicit seller confirmation. Mercari, Facebook Marketplace,
and Depop receive honest assisted share/handoff flows that never claim SnapList filled or published
the destination form. Optional cost basis supports estimated proceeds and profit, but the product
never labels a number as profit when cost is unknown.

SnapList is a **seller's control surface**, not a marketplace — payment, checkout, and shipping stay
on eBay. Buyers never see SnapList.

### Locked native launch contract

The following product decisions are implementation constraints. ADR-0008 defines their testable
entitlement, settlement, and marketplace-authority semantics.

- Primary user: the average consumer reseller; advanced volume workflows remain
  a growth path rather than the default product posture.
- Pre-value onboarding has no seller questionnaire. Optional lightweight
  personalization may appear only after a usable first draft.
- Guest entitlement: one App Attest-backed complete AI item run plus exactly one
  guided identity correction for the same item/photo set. Manual editing that
  preserves the immutable photo-set fingerprint is unlimited. Adding, replacing,
  or removing a photo creates a changed photo set. Technical retries/recovery do
  not spend another credit.
- The first usable listing and first seller-confirmed eBay publish are free.
  Account creation/eBay connection occur only when the guest chooses Publish.
- SnapList Pro's hard paywall appears when complete AI item run #2 begins. Paid
  usage is a configurable monthly AI-item allowance; the public number waits for
  TestFlight median/p95 cost data. Do not preserve the legacy daily allowance as
  the new native product promise.
- Credit accounting: reserve at run start, settle when a usable draft exists,
  restore on failure/cancel before usable output, bundle internal retries and the
  one guided correction, and charge a new credit for a new item/photo set/full
  re-analysis.
- No autonomous publish, repricing, ending, relisting, or message sending at
  launch. Consequential eBay actions require seller confirmation.
- SnapList owns unpublished drafts. After publish, eBay is authoritative for
  listing/order truth. External changes sync into SnapList; SnapList changes go
  through the adapter and reflect the confirmed eBay result. Conflicts are
  explicit, never silent last-write-wins.
- Launch navigation: Home, Listings, central Capture, Inbox, Insights; Account
  from profile; Runs contextual from Home; bell-backed activity center.
- Push only for draft ready, failed/needs-input run, buyer message, sold/order
  action, expired eBay connection, and failed assisted export.
- Assisted Mercari, Facebook Marketplace, and Depop share/handoff flows ship at
  launch but never claim direct publishing.
- Sold-elsewhere confirmation has `Also end on eBay` selected by default while
  preserving one explicit seller confirmation.
- Thin post-sale launch surface reflects eBay sold/paid/ship-by/shipped/delivered/
  canceled/tracking truth. Safe writes only where verified APIs support them;
  full returns/refunds/disputes/label purchasing stay on eBay initially.
- Item cost is optional on the draft and asked again at sale. Without it, show
  revenue/estimated net proceeds, never profit. Later cost entry updates profit.
- Scout guidance is curated, deterministic, localizable, and state-driven; AI
  usage is reserved for the listing pipeline.
- Guest recovery remains encrypted for 24 hours. Temporary processing copies
  expire after operational recovery needs. Listing/account deletion purges
  associated SnapList data subject to required provider/legal records.

For the standard eBay Fulfillment API, `FULFILLED` means shipped/fulfilled by the seller; it is not
dependable carrier-delivered confirmation. SnapList shows delivered only when a separately approved,
authoritative source supports it and otherwise hands that status check to eBay.

## User Stories

**Capture, identification & first value**
1. As a seller, I want to start with one item and no seller questionnaire, so that I reach value before personalization.
2. As a seller, I want to take or choose 1–4 photos, so that identity, condition, and damage can be assessed accurately.
3. As a seller, I want the system to read a visible ISBN or UPC, so that it can identify the item without pretending every barcode is a price source.
4. As a seller, I want brand, model, category, condition, and key specs extracted as structured data, so that the listing and price are grounded in real attributes.
5. As a seller, I want ambiguity shown rather than silently guessed, so that I understand what needs review.
6. As a guest, I want one complete AI item run without creating an account, so that SnapList proves its value first.
7. As a guest, I want the complete usable draft to remain manually editable, so that editing or saving never forces signup.
8. As a guest, I want exactly one guided identity correction for the same item and photo set, so that one model mistake does not waste my demonstration.
9. As a guest, I want the usable result encrypted and recoverable for 24 hours, so that a crash or accidental exit does not erase it before I choose whether to create an account.

**Pricing & proceeds**
10. As a seller, I want a suggested used-item price, range, confidence level, and evidence, so that I can judge the recommendation.
11. As a seller, I want evidence-backed sources and an honest uncited label on the terminal LLM-only estimate, so that I am not misled.
12. As a seller, I want exact ISBN lookup, sold comps, web comps, depreciation, and fallback estimates routed by available signals, so that the strongest honest tier wins.
13. As a seller, I want generic items to show low confidence rather than false precision.
14. As a seller, I want to override the suggested price, so that I retain final control.
15. As a seller, I want item cost to be optional on the draft and requested again when recording a sale, so that I can add it when I know it.
16. As a seller, I want revenue and estimated net proceeds when cost is unknown, with profit shown only after cost is supplied, so that missing data never becomes fake profit.

**Listing generation, review & approval**
17. As a seller, I want a generated eBay draft with platform-valid title, item specifics, description, and photos, so that I do not write it from scratch.
18. As a seller, I want generated copy grounded in validated item facts and similar listings, so that it does not invent claims.
19. As a seller, I want to manually edit the complete draft, including identity, condition, title, description, specifics, photos, and price.
20. As a seller, I want one bounded guided identity correction to re-price and regenerate only dependent fields without mixing stale identity, confidence, price, or copy.
21. As a seller, I want confidence and attention signals to mark readiness without publishing anything, so that the easy cases stand out while I retain control.
22. As a seller, I want every consequential eBay action to require my explicit confirmation, regardless of confidence.

**Account, entitlement & recovery**
23. As a guest, I want account creation to become blocking only when I tap **Publish to eBay**, so that signup does not interrupt first value.
24. As a guest, I want authentication to claim my recoverable result and return me to the same draft before eBay connection.
25. As a new seller, I want my first usable listing and first seller-confirmed eBay publish to remain free.
26. As a seller, I want the SnapList Pro paywall only when I attempt complete AI item run #2, so that editing or publishing an existing draft does not consume another credit.
27. As a SnapList Pro subscriber, I want a configurable monthly AI-item allowance with localized StoreKit price and status, so that the product does not promise a guessed public limit.
28. As a seller, I want a credit reserved when processing starts, settled only after a usable draft exists, and restored after failure/cancellation before usable output.
29. As a seller, I want internal retries, crash recovery, queue redelivery, and my included guided correction to reuse the same credit.
30. As a seller, I expect a new item, new photo set, or full re-analysis to use another credit.

**eBay publish, authority & synchronization**
31. As a seller, I want to connect my eBay account only when I choose to publish, so that permissions are requested in context.
32. As a seller, I want my confirmed draft published through the eBay adapter, so that it goes live under my identity.
33. As a seller, I want SnapList to own unpublished drafts and eBay to be authoritative after publish for listing and order truth.
34. As a seller, I want external eBay changes synchronized into SnapList and seller-confirmed SnapList changes sent through the adapter, so that the app reflects confirmed provider results.
35. As a seller, I want synchronization conflicts shown explicitly, so that no silent last-write-wins behavior overwrites marketplace truth.
36. As a seller, I want a seller-confirmed add-tracking/mark-shipped action where the standard Fulfillment API supports it.
37. As a seller, I want eBay `FULFILLED` labeled shipped rather than carrier-delivered, so that the app does not overstate provider truth.

**Assisted marketplaces & sold elsewhere**
38. As a seller, I want assisted Mercari, Facebook Marketplace, and Depop flows with platform-appropriate text, photos, a native share/deep-link handoff, and a short completion checklist.
39. As a seller, I want those assisted flows to say that I finish the destination form, so that SnapList never claims direct publishing.
40. As a seller, I want to record a sale elsewhere with marketplace, sale price, and optional fees/cost, so that Insights can include seller-entered truth.
41. As a seller recording a sale elsewhere, I want **Also end on eBay** selected by default but executed only after one explicit confirmation.
42. As a seller, I want SnapList-managed eBay offers withdrawn through the Inventory API and other mapped listings ended only when ownership/mapping is verified.

**Post-sale, activity & guidance**
43. As a seller, I want a thin eBay post-sale view of sold, paid, ship-by, shipped, canceled, and tracking truth, with delivered shown only from an approved authoritative source.
44. As a seller, I want cancellations, refunds, returns/cases, disputes, and label purchasing represented as status and honest eBay handoffs at launch rather than risky financial automation.
45. As a seller, I want Home, Listings, central Capture, Inbox, and Insights as primary navigation, with Account in profile and Runs contextual from Home.
46. As a seller, I want a bell-backed activity center and Home to surface the most consequential current work.
47. As a seller, I want push only for draft ready, processing failed/needs input, buyer message, sold/order action, expired eBay connection, and failed assisted export.
48. As a seller, I want Scout guidance to use curated, deterministic, localizable state-based messages, so that listing-pipeline AI budget is not spent on decorative chat.

**Buyer messaging**
49. As a seller, I want incoming eBay buyer questions to appear in a live inbox.
50. As a seller, I want the system to draft a grounded reply and show its evidence, so that I can answer accurately and fast.
51. As a seller, I want to approve or edit every reply before it sends, so that launch messaging is never autonomous.
52. As a seller, I want approved text and supported photos delivered together when the provider contract supports them, so that a failed photo never masquerades as text-only success.
53. As a seller (demo), I want to simulate an incoming question without implying a real eBay delivery.

**Trust, security & lifecycle**
54. As a seller, I want my items, listings, messages, and photos isolated from other users' data.
55. As a seller, I want credentials and tokens stored securely and marketplace mutations scoped to my connected account.
56. As a guest, I want unclaimed encrypted local and server artifacts deleted after the 24-hour recovery window.
57. As a seller, I want listing deletion to remove associated SnapList data subject to required provider/legal records.
58. As a seller deleting my account, I want the full applicable purge while eBay-owned records remain clearly identified as eBay's responsibility.

**Showcase/operator stories**
59. As the builder, I want every pipeline run's predictions logged for evaluation.
60. As the builder, I want an eval harness over a fixed gold set for ID accuracy, pricing sanity, and confidence calibration.
61. As the builder, I want pricing and marketplace providers behind testable seams, so that offline fixtures prove behavior without live calls.
62. As the builder, I want sandbox→production to remain an owner-controlled credential/configuration change rather than a rewrite.

**Advanced growth path (not the default launch posture)**
63. As a higher-volume reseller, I want to capture multiple items in a haul while each item retains its own pipeline run, evidence, review, and credit.
64. As a higher-volume reseller, I want inventory-scale workflows added only after the one-item native path and unit economics are validated.

## Implementation Decisions

### Framing & architecture
- **Average consumer reseller first.** The default launch path gets one item to a usable draft and a
  seller-confirmed eBay publish. Bulk/haul and other advanced volume workflows are additive growth
  paths, not the product's primary posture.
- **AI pipeline is the product; eBay is the only direct launch marketplace.** eBay publishing,
  synchronization, fulfillment writes, and messaging live behind adapter seams. The first-value AI
  path remains independently testable and eBay authority begins only after publish.
- **No pre-value questionnaire.** Optional category/frequency personalization may appear only after a
  usable first draft and must remain skippable.
- **Env-configurable throughout.** Sandbox→production is a credential/`EBAY_BASE_URL` flip. No hardcoded providers or endpoints.

### Tenancy & data
- **Multi-tenant from day one.** Clerk auth reaches Supabase through third-party JWTs; every domain table carries the text Clerk `user_id`, and **Postgres row-level security** enforces per-user isolation. This is a primary Security-skill surface.
- **Postgres + pgvector** (Supabase) holds items, listings, messages, embeddings, and prediction logs.
- **Photos** in Supabase Storage, paths scoped by `user_id`, access governed by RLS/storage policies.
- **Guest artifacts have a separate, bounded lifecycle.** The one App Attest-backed guest allowance
  retains encrypted photos, run state, and usable output for 24 hours after the usable draft exists.
  A successful account claim transfers ownership atomically; otherwise local recovery data and
  server-side guest artifacts expire. Temporary processing copies live only as long as operational
  recovery requires. See ADR-0008.
- **Review writes are coherent and revision-guarded.** Seller edits, identity regeneration, export
  packs, applied reprices, and publish acquisition coordinate through an item-owned review revision.
  Seller-price changes advance it; export persistence verifies both the reusable content revision and
  current full revision, while eBay publish atomically claims the full review snapshot before any
  external call. Identity regeneration commits the corrected item, regenerated eBay draft, and
  prediction log in one RLS-scoped transaction; stale writers fail instead of mixing runs, and the
  seller price cannot change while an eBay publish claim is active.
- Schema (conceptual, not final): `items` (user_id, attributes JSON, condition, photos[],
  price_override, review_revision, review_content_revision, created_at), `listings` (item_id,
  platform, generated copy, status, source_review_revision), `messages` (item_id/listing_id,
  direction, body, draft_reply, marketplace, exact external identities, delivery state), per-seller
  `message_attachments` (tenant/message/request identity, private object path, hosted-provider
  reference, delivery state), messaging sync/reconciliation state, `embeddings`/corpus (vector, source ref, metadata),
  `prediction_logs` (item_id, extracted attrs, price, range, confidence, tier_fired, model used).

### Native activation, entitlement & AI-item credits
- **First value before identity.** One device gets one App Attest-backed complete AI item run and
  exactly one guided identity correction for the same item/photo set. Manual edits that preserve
  the immutable photo-set fingerprint are unlimited; adding, replacing, or removing a photo changes
  the photo set and requires a new run.
  Account creation and eBay connection become blocking only when the guest chooses **Publish to
  eBay**; after authentication the same guest result is claimed and reopened.
- **First listing and first publish are free.** SnapList Pro does not interrupt the first usable draft
  or its first seller-confirmed eBay publish. The hard paywall appears when complete AI item run #2
  attempts to reserve capacity.
- **Monthly, not daily, product entitlement.** SnapList Pro grants a configurable monthly AI-item
  allowance. For an Apple-billed seller, the allowance follows the server-verified StoreKit
  subscription period, not a calendar month or a client clock. A verified renewal advances it once;
  verified grace preserves the current period's remainder without resetting; late or ambiguous state
  fails closed to the last verified period. StoreKit supplies localized price and subscription state.
  The public allowance remains unset until TestFlight measures median and p95 cost per usable item.
  Existing server daily limits remain legacy operational guardrails until a focused reconciliation
  issue replaces them; they are not the native product promise and must not be presented as credits.
- **Reservation settles on durable value.** Reserve one credit before provider-backed processing;
  settle it exactly once only after the coherent item, price recommendation, and editable draft are
  durably available. Failure or cancellation before that point restores the reservation exactly once.
  Internal retries, recovery, redelivery, and the included guided correction reuse the logical
  reservation. A new item, changed photo set, or requested full re-analysis requires a new credit.
  See ADR-0008.

### Models & LLM access
- **Vercel AI SDK behind a role-keyed provider registry** (`src/lib/llm`, ADR-0002). Provider is a config flip via `LLM_PROVIDER`: **dev defaults to Gemini** (generous free tier — protects the OpenAI budget), the **showcase runs on OpenAI**. A strong multimodal model handles vision + structured extraction; model ids are per-role and provider-aware, confirmed against current docs at build time. Embeddings stay on a fixed provider (pgvector `vector(1536)` dimension lock).
- **Structured outputs** via the AI SDK's `generateObject` + **Zod** schemas (attributes, listing, price recommendation). Validation + retry on schema mismatch.
- **Cost-aware model routing:** cheap model for easy/high-confidence work, escalate to the strong model for hard/low-confidence items. Routing is itself a showcased technique and feeds the confidence story.
- Provider stays swappable behind the SDK (config flip).

### Pricing pipeline (behind a `PricingProvider` interface; routing pipeline, not one source)
Routing by item signal, each result always `{ suggested, range, confidence, sources[] }`, always user-editable:
1. **ISBN present** → true structured catalog lookup (Open Library + Google Books, free). Highest identification confidence; pricing trust remains estimate-level unless the result is also sold-backed.
2. **Identifiable item → eBay sold comps** → retrieve real completed-sale comps behind a provider-neutral `ebay-sold` strategy. The leading automatic candidate is the default-off Caffein Apify adapter, whose untrusted rows must pass the shared anchor/corroboration/reject matcher; the public sold/completed page provider remains its immediate fallback. Both are read-only price research, never posting mechanisms, and any failure/thin anchor set falls through. See **ADR-0001**.
3. **UPC present** → decode as a strong **identification/query aid** (not a price oracle — no reliable free UPC price API). Feed decoded code + resolved product name into the web-search agent; price comes from comps.
4. **Recognizable branded item** → **bounded tool-calling web-search pricing agent** (see below).
5. **Generic, only retail found** → retail × condition-based depreciation factor, labeled low-confidence estimate.
6. **Ultimate fallback** → LLM-only estimate, lowest confidence.
- **Outbound price contract:** a valid, positive, cent-normalized seller override is the effective
  price for eBay publishing and every Facebook/Mercari export pack, including cached packs. Only when
  no usable override exists do those paths fall back to the latest pipeline suggestion. Prediction
  logs keep the recommendation for evaluation; choosing an override never rewrites that history.
- eBay **Browse** API dropped; eBay **Marketplace Insights** (true sold prices) is gated/unavailable to solo devs — not used **as an API**. Instead, eBay's PUBLIC sold-listings *pages* are scraped (ADR-0001) for real sold comps. Open-web comps (web-search tier) remain mostly *asking* prices; the agent seeks resale/sold signals and **down-weights confidence when only asking prices are found**. Honest ceiling: a *smart, sold-grounded suggestion*, not an oracle.
- **Sold-comps retrieval is best-effort and configurable.** Caffein Apify is
  default-off and requires explicit config; its normalized output never bypasses
  the provider-neutral matcher. The public-page fallback uses direct HTTPS by
  default, while hosted environments may set one validated, vendor-neutral
  `EBAY_SOLD_PROXY_TEMPLATE`. Missing config preserves the fallback, malformed
  config fails before egress, and Actor/public blocked or thin results decline to
  lower tiers. Provider credentials and raw upstream errors never enter results,
  reports, cache keys, or pricing diagnostics.
- **Freshness:** sold prices drift, so the source of truth is a **live fetch at query time**; a TTL cache-on-miss + recency/age-decay layer (#59) cuts footprint without becoming the authority. The pgvector **reference corpus** grounds listing copy and *corroborates* pricing — it is **never** the price oracle.

### Pricing research agent
- **Genuine but bounded tool-calling loop:** formulate targeted queries (e.g. `"{brand} {model} used resale price sold"`) → search → judge coverage/agreement → optionally refine **once** → synthesize a **cited** range. Capped at ~2–3 search iterations for cost/latency.
- **Search providers:** Tavily primary (clean LLM-ready content), Exa secondary (neural search). Both keys already held.
- Handles the "found nothing useful" path by falling through to the depreciation / LLM-only tier.

### Confidence (signature feature: confidence-gated publish eligibility)
- **Signal-based composite, NOT LLM self-report.** Inputs:
  - which evidence/trust tier fired (sold-backed ISBN > tight sold comps > strongly corroborated web comps > wide web comps > depreciation/catalog estimate > LLM-only),
  - **comp agreement** (variance/dispersion of found prices — tight cluster = confident),
  - **identification completeness** (brand + model resolved? barcode decoded cleanly? category unambiguous?).
- Publish eligibility gate = threshold on the composite. High → marked ready to publish; low → review. The preference is toggleable off. Eligibility never invokes the eBay adapter; the seller explicitly chooses **Publish to eBay**. The signals are surfaced for transparency.
- A seller-triggered identity correction is always a pre-publish, human-controlled run: it
  recomputes the composite but resets the regenerated eBay listing to `draft` and never auto-posts.

### Vision / identification
- **1 photo required, up to ~4 accepted.** All provided images fed to a **single** structured-extraction vision call → attributes + condition + barcode/ISBN. More angles → better condition assessment → higher ID confidence.
- Output is Zod-validated against the attribute schema.

### Advanced bulk / haul growth path
- **Additive, not the default launch posture.** A higher-volume seller may stage multiple items in one
  session, but the primary native activation path remains one item to one usable draft.
- **Same pipeline and credit semantics per item.** Each staged item keeps its own photos, durable run,
  reservation, evidence, confidence, review, and seller confirmation. Batch capture never grants a
  shared AI-item credit or weaker review contract.
- **No launch automation follows from volume.** Existing bulk capture may remain available, but
  autonomous repricing, publishing, ending, relisting, or messaging is outside the launch contract.

### Durable pipeline execution
- **The whole listing-preparation run is durable.** Photos remain in private, seller-scoped Storage;
  a tenant-owned `pipeline_runs` row records status, stage, attempts, item/listing links, safe failure
  details, and timestamps; a logged Supabase Basic Queue carries only the strict versioned envelope
  `{ run_id, schema_version }`. Refreshing or closing the browser must not erase accepted work.
- **One TypeScript pipeline, two queue backends.** Production uses Supabase PGMQ through a
  transport-neutral adapter; offline tests use the in-memory backend with the same claim,
  visibility-timeout, redelivery, defer, and explicit-ack contract. The consumer claims a bounded
  batch, checkpoints validated identify/price/generate output, fences attempts with an expiring lease,
  and acknowledges only after durable success or terminal failure. The queue never publishes,
  messages, charges, or becomes a second pipeline implementation.
- **Internal queue authority is not tenant-domain authority.** Claim/ack is a narrow internal
  capability. Worker reads and writes remain RLS-scoped or use audited run-derived RPCs that never
  trust a tenant id from a message/caller and cannot cross the stored run → item → listing ownership
  relationships. A generic service-role domain client is prohibited. See ADR-0007.
- **Operations are bounded and inactive by default.** The provider-neutral worker and maintenance
  HTTP seams fail closed without a bearer secret; no migration activates hosted Cron. The owner-only
  Supabase Cron + pg_net template reads its origin and secret from Vault. V1 scheduled requests claim
  one message with a 300-second worker lease, use three attempts with bounded backoff, hourly retention, and structured
  queue/run/cleanup health. Successful listing photos are retained; abandoned captures become
  accounting tombstones only after 30 days; exact Storage cleanup jobs retry five times before a
  visible dead letter. See `docs/runbooks/durable-pipeline-operations.md`.

### Listing generation (per-platform)
- **One Zod-validated attribute core → many surface renderings** via per-platform prompt + template.
- **Bounded pre-publish correction loop.** The review editor can replace brand, model, category,
  condition, valid ISBN/UPC, and up to 12 relevant specifications. Its explicit re-price/regenerate
  action reuses the pricing router, confidence bridge, and grounded eBay generator; preserves a
  saved seller price override; invalidates identity-bearing export packs; and leaves the last
  coherent result untouched if generation or persistence fails. Published or publishing eBay
  state is never mutable through this path.
- v1 direct target: **eBay** (structured item specifics, keyword title, category, and the real adapter
  target). Launch assisted handoffs target **Facebook Marketplace**, **Mercari**, and **Depop** with
  platform-appropriate copy/photos and an honest native share/deep-link checklist. They never claim a
  direct post. Poshmark remains a later option if the branded-apparel slice is expanded.
- Generation is **grounded** by pgvector retrieval of similar past/seed listings (few-shot).

### RAG (pgvector)
- **Seeded reference corpus from day one** (hero-domain-weighted; curated or realistic-synthetic, with prices + good copy). Avoids cold-start.
- Two live jobs: (a) **ground pricing** as a corroborating signal feeding confidence; (b) **few-shot the listing generator**.
- README discloses honestly if the corpus is synthetic.

### Item domain
- **Hero domain + graceful degradation — a positioning choice, not a caveat.** The hero domain *is* reseller inventory: books/media (ISBN), consumer electronics, video games and consoles, board games, LEGO, sneakers, branded clothing/streetwear, and branded gear. These are exactly the categories where eBay public **sold comps** are dense, so the pricing tier is genuinely strong and the suggestion is defensible. We concentrate there on purpose rather than chasing a "price anything" guarantee. Generic household items still flow through the same pipeline but honestly show low confidence. Demo arc: exact barcode → researched sold comps → correctly-flagged generic.

### eBay adapters (real, built behind interfaces)
- **Posting:** eBay Sell API publish (sandbox first → production).
- **Authority and synchronization:** SnapList owns unpublished drafts. After publish, eBay is
  authoritative for listing and order truth. External changes sync into SnapList; every
  seller-confirmed SnapList mutation goes through the adapter and is persisted only from the
  confirmed provider result. Divergent local/provider revisions produce an explicit conflict state,
  never silent last-write-wins.
- **Launch mutations are allowlisted and seller-confirmed.** Direct writes are publish; add
  tracking/mark shipped through `createShippingFulfillment`; and end a listing recorded sold
  elsewhere through Inventory `withdrawOffer` for SnapList-managed offers or the verified Trading
  end call for an owned, mapped legacy listing. `FULFILLED` is labeled shipped, not confirmed
  delivered. Cancellations, refunds, returns/cases, disputes, and label purchasing remain status and
  eBay handoff surfaces at launch.
- **Messaging:** the shared foreground/background sync service imports unresolved pre-sale questions,
  preserves provider identity, and drafts grounded replies. Launch never auto-sends: every reply or
  follow-up requires explicit seller confirmation before the adapter call. Delivery failures and
  ambiguity remain visible/retryable, overlapping windows are deduplicated, and simulated messages
  never masquerade as eBay delivery.
- **Demo messaging:** seeded/simulated buyer messages remain available for a credential-free demonstration and use an explicitly simulated adapter; they never masquerade as an eBay delivery.
- **Account-deletion notification endpoint:** verifies signed notices, then atomically erases matching seller credentials, buyer-message trees, notifications, sync/reconciliation state, and private identity provenance. Production subscription remains an owner-controlled go-live step.
- **Secrets:** transactional calls use **per-user encrypted OAuth tokens**. One explicitly configured operator tenant/seller may use app-level credentials only against the exact Sandbox API origin; production never permits that fallback.

### Launch information architecture, activity & guidance
- **Primary navigation:** Home, Listings, a prominent central Capture action, Inbox, and Insights.
  Account/Settings opens from profile. Runs are contextual from Home and persistent processing
  status rather than a primary tab.
- **Activity:** the notification bell opens the complete activity center; Home surfaces the most
  consequential current work. Push is restricted to draft ready, processing failed/needs input,
  buyer message, sold/order action, expired eBay connection, and failed assisted export. Routine
  stage changes and successful syncs remain in-app.
- **Insights honesty:** item cost is optional and may be requested again when recording a sale. With
  no cost basis, show revenue, estimated fees, and estimated net proceeds, never profit. Adding cost
  later may update profit retroactively.
- **Scout guidance:** curated, deterministic, localizable, and driven by real app/backend state. It
  may insert verified item facts into bounded templates but does not use free-form AI at launch.

### Eval & observability
- **Log every run's predictions from day one** (extracted attributes, chosen price, range, confidence, tier fired, model). Prerequisite for evaluation.
- **Lightweight-but-real eval harness** over a fixed gold set (~30–50 hero-domain items): ID field accuracy, pricing-within-band (median error + % within band), **confidence calibration** (reliability bucketing), and **listing quality** via a *validated* LLM-judge rubric. Script first; CI later (Phase 4). Gold set doubles as demo set and overlaps the seed corpus.

### Deploy
- **Split marketing from trusted native compute.** Keep the public marketing site on Vercel. The
  development target is $0 local Supabase plus the provider-neutral local Node API/worker. Issue #195
  proves health/session/internal-consume composition and durable worker behavior; the enqueue/RLS v1
  API remains contract-only under #159. After the owning API/auth issues land, a remote pre-revenue
  test may use Supabase Free plus an optional sleeping Render Free API while the Node worker runs only
  during supervised local sessions; queued work honestly waits while that worker is offline. Railway
  is the deferred paid target only after external TestFlight needs reliable unattended processing, a
  measured free-host limit blocks validation, or first revenue/payment activation justifies an
  owner-approved commitment. Supabase continues to own Postgres, Storage, Realtime, and PGMQ. This
  decision does not authorize provider setup, billing, deployment, DNS, hosted Cron, credentials, or
  hosted-data mutation.

## Testing Decisions

**Methodology:** **Tracer-bullet development with TDD.** Each feature is a thin end-to-end thread —
one or two backend pieces + a minimal frontend to exercise them + tests — proven working before the
next. No full-backend-then-frontend; no layer-by-layer build. Tight feedback loop; integration seams
exist and are tested continuously.

**What makes a good test here:** assert **external behavior at a seam**, not implementation details.
Because LLM/web outputs are non-deterministic, deterministic logic and I/O boundaries are tested
directly, while model calls are tested against **contracts** (schema validity, invariants) and
exercised for quality by the **eval harness** rather than brittle exact-match unit tests.

**Proposed seams (highest-level first; confirm before building):**
- **`PricingProvider` interface** — the primary seam. Each tier (ISBN lookup, web-search agent,
  depreciation, LLM fallback) is a provider; the **router** is tested with stubbed providers to
  assert correct tier selection per input signal. Tier implementations are tested against contracts.
- **Vision extraction boundary** — given image input(s), output **must validate** against the Zod
  attribute schema (contract test); quality measured by eval harness, not unit assertions.
- **Confidence function** — pure, deterministic given its signal inputs. **Unit-tested directly**
  with crafted signal sets (tight sold comps → high, wide comps → low, catalog-only ISBN → estimate-level, etc.). This is the
  most important pure-logic test target.
- **Listing generators** — per-platform output validated against platform constraints (e.g. eBay
  title length, required fields present, no attributes hallucinated beyond the validated core).
  Contract + rubric, not exact text.
- **Review regeneration** — stub pricing/listing dependencies at the public orchestration seam and
  assert corrected facts feed both outputs; integration-test atomic item/listing/log persistence,
  price-override preservation, stale-revision rejection, live-listing exclusion, export invalidation,
  and cross-tenant rollback.
- **Guest allowance and credit ledger** — table-test the device-bound first-run allowance, same-item/
  same-photo-set guided correction, manual-edit exclusions, reservation idempotency, usable-draft
  settlement, failure/cancel restoration, retry/redelivery reuse, monthly reset, and run-#2 paywall.
- **RLS / tenancy** — integration tests asserting a user cannot read/write another user's
  items/listings/messages/photos. Security-critical; tested at the data-access seam.
- **eBay adapters** — publishing, synchronization, add-tracking/mark-shipped, end-listing, and
  marketplace messaging are tested against **mock adapters** (plus fake HTTP at the provider
  contract), never live eBay. Contract tests prove seller confirmation, ownership/mapping,
  confirmed-result persistence, explicit conflict states, and that `FULFILLED` never renders as
  carrier-delivered.
- **Assisted handoffs** — contract-test that Mercari, Facebook Marketplace, and Depop output contains
  platform-specific content while every completion path states the seller finishes in the
  destination app.
- **Eval harness** — itself validated: the LLM-judge is checked against a small human-labeled subset
  so we're not trusting an unvalidated judge.

**Prior art:** none yet (greenfield). Establish the patterns above as the reference for later tests.

## Out of Scope

- Direct posting or form automation for Mercari, Facebook Marketplace, Depop, Poshmark, or OfferUp
  without an approved official partner API. Launch assistance is share/deep-link/checklist only and
  never scraping **to post**. Read-only scraping of eBay's PUBLIC *sold* pages for price research is
  in scope (ADR-0001).
- Autonomous eBay publishing, repricing, ending, relisting, fulfillment writes, or message sending.
  Confidence/readiness may recommend an action but never authorizes it.
- Treating standard Fulfillment `FULFILLED` as carrier-delivered. Logistics API access is not a
  launch dependency; without an approved authoritative source, delivery status stays on eBay.
- Direct launch mutations for cancellations, refunds, returns/cases, disputes, or label purchasing.
  SnapList may reflect readable state and deep-link the seller to eBay.
- Cross-platform unified inbox or authoritative order tracking; eBay is the only direct launch
  marketplace.
- Sold-price *APIs* (gated eBay Marketplace Insights) and eBay **Browse** API (dropped). Sold-price *data* is obtained instead by scraping eBay's PUBLIC sold pages (ADR-0001).
- Real users / growth / marketing as a success metric (showcase first).
- Payment, checkout, shipping (these stay on eBay).
- A universal "price anything" guarantee — accuracy concentrates on the hero domain; generics are honestly low-confidence.
- Automatic publish after seller-triggered identity correction — regeneration always returns to a
  reviewable draft.
- A pre-value seller questionnaire. Optional personalization begins only after a usable first draft.
- Presenting legacy daily server limits as the native SnapList Pro entitlement or public allowance.
- Making bulk/haul or inventory-scale automation the default launch posture.

## Further Notes

- **Brief reconciliation:** `PROJECT_BRIEF.md` predates this PRD and still reflects pre-decision
  defaults (single-source-leaning eBay framing, "any household item", `gpt-4o` default, etc.). This
  PRD overrides those. Keep the brief as origin/narrative context.
- **Skills-on-display map** (for README + interview narrative): multimodal vision (extraction),
  agents + tool calling (pricing agent, buyer-Q&A agent), RAG/synthesis (cited web-search range, similar-item
  grounding), structured Zod outputs, prompt/context engineering (per-platform generation,
  used-vs-new disambiguation), pgvector, security (Auth + RLS + secret handling + input validation +
  account-deletion endpoint), cost-aware model routing, evals + calibration, Docker/CI/observability (Phase 4).
- **Coherence to emphasize:** the *pricing tier that fired* → *confidence score* → *eval calibration*
  is one spine seen three ways. Lead with that in interviews.
- **Honesty as a selling point:** UPC isn't a free price oracle; asking-prices ≠ sold-prices; synthetic
  corpus disclosed. Being able to state the system's accuracy ceiling is a differentiator.

### Phase sequencing (tracer-bullet, not rigid)
- **Phase 0 — contract and foundations:** canonical product/ADR contract; repo and server foundations;
  Clerk/Supabase tenancy; durable pipeline seams; native design approval; operator-controlled provider
  configuration. Do not begin native implementation from stale daily-capacity or launch-autonomy docs.
- **Phase 1 — first usable guest value:** App Attest-backed guest capture → durable identify/price/draft;
  complete manual editing; one guided same-item/photo-set correction; encrypted 24-hour recovery;
  no pre-value questionnaire.
- **Phase 2 — claim, metering, activity:** claim the guest result at Publish; monthly AI-item credit
  reservation/settlement and run-#2 SnapList Pro gate; Home/contextual Runs/activity center; bounded
  push; seller-approved buyer-reply delivery.
- **Phase 3 — eBay authority and assisted launch marketplaces:** first seller-confirmed eBay publish;
  two-way listing/order synchronization with visible conflicts; seller-confirmed add-tracking/
  mark-shipped and sold-elsewhere end; Mercari/Facebook/Depop assisted handoffs; thin honest
  post-sale status.
- **Phase 4 — measure and harden:** TestFlight cost measurement before publishing the monthly
  allowance; retention/deletion acceptance; production go-live checklist; eval/CI/observability;
  validate advanced bulk/volume work without changing the default one-item posture.
