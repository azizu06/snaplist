# SnapList — Product Requirements Document

> Status: **Ready for build.** Supersedes the decision-open parts of `PROJECT_BRIEF.md`.
> The brief remains the narrative/origin record; this PRD is the source of truth for what we build.
> Working name; idea origin: Ideabrowser "Home Sale Helper" #1613.

---

## Problem Statement

Resellers list in volume, and the per-item work does not scale. Someone flipping thrift finds,
sneakers, streetwear, electronics, games, or LEGO has to, for every item: photograph it, research
what it actually *sold* for used (not retail, not the optimistic asking price), write a competent
platform-appropriate listing, post it, and then answer the same buyer questions over and over.
That is ~20–30 minutes of low-value labor per item, and the pricing research is the worst of it:
real completed-sale prices are tedious to dig out and retail prices are misleading for used goods.
Multiply that by a haul of ten or fifty items and the research alone eats the day. Existing
cross-listing tools (Vendoo, List Perfectly, Crosslist) copy a listing across marketplaces but
still make the seller do the identification, the pricing, and the writing by hand.

The **primary user is the reseller** — the person who moves inventory in the hero domain (below),
where real sold comps exist and pricing can be genuinely defensible. Casual one-off sellers are
welcome and the flow serves them, but the product is tuned for volume.

(Framing note: this is built as a **production-real AI-engineering showcase**. The primary success
metric is demonstrating the full AI stack end-to-end in a polished, deployed app — not user growth.
Market saturation is explicitly irrelevant.)

## Solution

SnapList turns a **photo of a resale item** into a **priced, ready-to-post listing**, and later drafts
buyer-message replies — collapsing the per-item work into a photo plus a couple of approvals so a
reseller can clear a whole haul in one pass.

The seller snaps 1–4 photos. The system identifies the item (brand, model, category, condition,
specs, and any barcode/ISBN), researches a defensible price range from **real sold comps when
available**, cited web or depreciation evidence when those tiers resolve, or a clearly labeled
terminal LLM-only estimate that may be uncited, then generates platform-specific listing copy and
shows it for review/edit. It captures **hauls
in bulk** (many items in one session), tracks **cost basis → net profit** per item, and can
**auto-reprice** listings that go stale. The confidence gate marks high-confidence items **ready to
publish** and sends lower-confidence ones to review; every eBay publish remains an explicit seller
action through the adapter. Listings also generate copy-paste export packs for Facebook Marketplace and Mercari.
A buyer-Q&A agent drafts grounded replies the seller approves before sending.

SnapList is a **seller's control surface**, not a marketplace — payment, checkout, and shipping stay
on eBay. Buyers never see SnapList.

## User Stories

**Capture & identification**
1. As a seller, I want to snap a single photo of an item, so that I can start a listing with minimal effort.
2. As a seller, I want to add up to ~4 photos from different angles, so that condition and damage are assessed accurately.
3. As a seller, I want the system to read a visible barcode/ISBN, so that identifiable items are priced more precisely.
4. As a seller, I want the system to extract brand, model, category, condition, and key specs as structured data, so that the listing and price are grounded in real attributes.
5. As a seller, I want to see what the system *thinks* the item is before it prices it, so that I can catch misidentification early.
6. As a seller, I want misidentified or ambiguous items flagged rather than silently guessed, so that I trust the output.

**Pricing**
7. As a seller, I want a suggested price for the item, so that I don't have to research it myself.
8. As a seller, I want a price *range* and a *confidence* level, not just a single number, so that I understand how reliable the suggestion is.
9. As a seller, I want to see the *sources* behind evidence-backed prices and an honest uncited label on the terminal LLM-only estimate, so that I can verify what is verifiable without being misled.
10. As a seller, I want pricing to reflect *used/resale* value rather than retail, so that my listing is realistic.
11. As a seller, I want books/media priced from an exact ISBN lookup, so that those listings are highly accurate.
12. As a seller, I want branded/recognizable items priced from real web comps, so that valuable items are priced well.
13. As a seller, I want generic items to get a rough estimate clearly labeled low-confidence, so that I'm not misled by false precision.
14. As a seller, I want to override the suggested price, so that I retain final control.

**Listing generation**
15. As a seller, I want a generated eBay listing (title, item specifics, description, tags), so that I can post without writing copy.
16. As a seller, I want copy-paste export packs for Facebook Marketplace and Mercari, so that I can list cross-platform without re-typing.
17. As a seller, I want each platform's copy to follow that platform's conventions (title length, tone, hashtags, structure), so that listings look native.
18. As a seller, I want the generated copy grounded in real similar listings, so that it reads like a competent human wrote it, not generic filler.
19. As a seller, I want to edit generated listing fields and, before publishing, correct the
    brand, model, category, condition, ISBN/UPC, or relevant specifications, then explicitly
    re-price and regenerate from those facts, so that I control the final listing without mixing
    stale identity, price, confidence, or copy.

**Review, approval & publish eligibility**
20. As a seller, I want to review and approve a listing before it posts, so that nothing goes live without my consent.
21. As a seller, I want high-confidence items marked ready to publish, so that the easy cases stand out.
22. As a seller, I want low-confidence items sent to review, so that mistakes do not go live.
23. As a seller, I want to see *why* an item was marked ready or sent to review (the confidence signals), so that the gate is transparent.
24. As a seller, I want to turn ready-to-publish eligibility off entirely, so that every item stays in the review flow.

**Posting & export**
25. As a seller, I want to publish a listing to eBay, so that it's actually for sale.
26. As a seller, I want my eBay listings persisted in SnapList with their status, so that I can track what I've posted.
27. As a seller, I want export packs as clean copy-paste blocks, so that pasting into other apps is frictionless.

**Buyer messaging (later phase)**
28. As a seller, I want incoming buyer questions to appear in a live inbox, so that I don't have to refresh.
29. As a seller, I want the system to draft a reply grounded in the item's attributes/listing, so that I answer accurately and fast.
30. As a seller, I want to approve or edit a drafted reply before it sends, so that I control what the buyer sees.
31. As a seller, I want replies delivered into the buyer's eBay inbox, so that the buyer never needs to leave eBay.
32. As a seller (demo), I want to simulate an incoming buyer question, so that the messaging flow is demonstrable without real buyer traffic.

**Account, trust & security**
33. As a seller, I want to sign up and sign in, so that my items are private to me.
34. As a seller, I want my items, listings, and messages isolated from other users' data, so that my data is secure.
35. As a seller, I want my photos stored privately, so that they aren't exposed to others.
36. As a seller, I want to connect my own eBay account (production), so that listings post under my identity.
37. As a seller, I want my credentials/tokens handled securely, so that my account isn't compromised.

**Showcase/operator stories (project-as-portfolio)**
38. As the builder, I want every pipeline run's predictions (attributes, price, confidence, tier) logged, so that I can evaluate quality later.
39. As the builder, I want an eval harness over a fixed gold set, so that I can report ID accuracy, pricing sanity, and confidence calibration.
40. As the builder, I want the pricing source behind a swappable interface, so that I can add/replace pricing strategies without rewrites.
41. As the builder, I want sandbox→production to be a credential flip, not a rewrite, so that going live is low-risk.

**Bulk / haul capture (reseller volume)**
42. As a reseller, I want to capture many items in one photo session (a "haul") instead of starting a fresh flow per item, so that listing a batch of pickups is one pass, not one-item-at-a-time.
43. As a reseller, I want each captured item in the haul to run the same identify → price → generate pipeline and land as its own reviewable listing, so that bulk capture never trades away per-item accuracy or my final say.

## Implementation Decisions

### Framing & architecture
- **AI pipeline is the product; eBay is a real but adapter-isolated integration.** eBay (posting + messaging) is genuinely intended and will be wired to real accounts in the final version, but it lives behind a clean interface and is **not on the Phase 1 critical path**. "Production-real" attaches to the AI app being deployed and live.
- **Env-configurable throughout.** Sandbox→production is a credential/`EBAY_BASE_URL` flip. No hardcoded providers or endpoints.

### Tenancy & data
- **Multi-tenant from day one.** Supabase Auth; every domain table carries `user_id`; **Postgres row-level security** enforces per-user isolation. This is a primary Security-skill surface.
- **Postgres + pgvector** (Supabase) holds items, listings, messages, embeddings, and prediction logs.
- **Photos** in Supabase Storage, paths scoped by `user_id`, access governed by RLS/storage policies.
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
  direction, body, draft_reply, status), `embeddings`/corpus (vector, source ref, metadata),
  `prediction_logs` (item_id, extracted attrs, price, range, confidence, tier_fired, model used).

### Models & LLM access
- **Vercel AI SDK behind a role-keyed provider registry** (`src/lib/llm`, ADR-0002). Provider is a config flip via `LLM_PROVIDER`: **dev defaults to Gemini** (generous free tier — protects the OpenAI budget), the **showcase runs on OpenAI**. A strong multimodal model handles vision + structured extraction; model ids are per-role and provider-aware, confirmed against current docs at build time. Embeddings stay on a fixed provider (pgvector `vector(1536)` dimension lock).
- **Structured outputs** via the AI SDK's `generateObject` + **Zod** schemas (attributes, listing, price recommendation). Validation + retry on schema mismatch.
- **Cost-aware model routing:** cheap model for easy/high-confidence work, escalate to the strong model for hard/low-confidence items. Routing is itself a showcased technique and feeds the confidence story.
- Provider stays swappable behind the SDK (config flip).

### Pricing pipeline (behind a `PricingProvider` interface; routing pipeline, not one source)
Routing by item signal, each result always `{ suggested, range, confidence, sources[] }`, always user-editable:
1. **ISBN present** → true structured catalog lookup (Open Library + Google Books, free). Highest identification confidence; pricing trust remains estimate-level unless the result is also sold-backed.
2. **Identifiable item → eBay public sold comps** → scrape eBay's PUBLIC sold/completed results pages (`LH_Sold=1&LH_Complete=1`) for real **completed-sale** comps — the strongest used signal, no API/login needed. Slots **above** the web-search tiers (sold beats asking). Read-only price research, never a posting mechanism. See **ADR-0001**.
3. **UPC present** → decode as a strong **identification/query aid** (not a price oracle — no reliable free UPC price API). Feed decoded code + resolved product name into the web-search agent; price comes from comps.
4. **Recognizable branded item** → **bounded tool-calling web-search pricing agent** (see below).
5. **Generic, only retail found** → retail × condition-based depreciation factor, labeled low-confidence estimate.
6. **Ultimate fallback** → LLM-only estimate, lowest confidence.
- **Outbound price contract:** a valid, positive, cent-normalized seller override is the effective
  price for eBay publishing and every Facebook/Mercari export pack, including cached packs. Only when
  no usable override exists do those paths fall back to the latest pipeline suggestion. Prediction
  logs keep the recommendation for evaluation; choosing an override never rewrites that history.
- eBay **Browse** API dropped; eBay **Marketplace Insights** (true sold prices) is gated/unavailable to solo devs — not used **as an API**. Instead, eBay's PUBLIC sold-listings *pages* are scraped (ADR-0001) for real sold comps. Open-web comps (web-search tier) remain mostly *asking* prices; the agent seeks resale/sold signals and **down-weights confidence when only asking prices are found**. Honest ceiling: a *smart, sold-grounded suggestion*, not an oracle.
- **Sold-comps egress is best-effort and configurable.** Direct HTTPS fetch is the default; hosted
  environments may set one validated, vendor-neutral `EBAY_SOLD_PROXY_TEMPLATE`. Missing/blank
  preserves direct fetch, malformed configuration fails before any request, and blocked/thin
  results decline to lower tiers. Proxy credentials and raw upstream errors never enter reports or
  pricing diagnostics.
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

### Bulk / haul capture (reseller volume)
- **Batch capture is a first-class flow, not a bolt-on.** A reseller can stage many items in one session — photograph item, "next item", repeat — then process the whole haul at once. This is the volume path the reseller ICP needs; single-item capture remains the simple default.
- **Same pipeline per item, no accuracy shortcut.** Each staged item runs the *identical* identify → price (sold-comps routing) → generate pipeline and lands as its own reviewable listing with its own confidence. Bulk is a capture/queueing convenience; it never fans out to a cheaper or shared prediction. Confidence-gated publish eligibility still applies per item; publishing remains manual.
- Complements the reseller-facing surfaces already shipped: **cost-basis → net-profit** tracking per item and scheduled **stale-inventory auto-repricing**. Auto-repricing requires its own explicit opt-in plus the publish-eligibility setting; it only applies a high-confidence price change to an existing live listing and never publishes a new listing.

### Listing generation (per-platform)
- **One Zod-validated attribute core → many surface renderings** via per-platform prompt + template.
- **Bounded pre-publish correction loop.** The review editor can replace brand, model, category,
  condition, valid ISBN/UPC, and up to 12 relevant specifications. Its explicit re-price/regenerate
  action reuses the pricing router, confidence bridge, and grounded eBay generator; preserves a
  saved seller price override; invalidates identity-bearing export packs; and leaves the last
  coherent result untouched if generation or persistence fails. Published or publishing eBay
  state is never mutable through this path.
- v1 targets: **eBay** (structured item-specifics, keyword title, category — the real adapter target), **Facebook Marketplace** (casual, local, short), **Mercari** (short title, hashtags, shipping-oriented). Poshmark optional if branded-apparel slice is added.
- Generation is **grounded** by pgvector retrieval of similar past/seed listings (few-shot).

### RAG (pgvector)
- **Seeded reference corpus from day one** (hero-domain-weighted; curated or realistic-synthetic, with prices + good copy). Avoids cold-start.
- Two live jobs: (a) **ground pricing** as a corroborating signal feeding confidence; (b) **few-shot the listing generator**.
- README discloses honestly if the corpus is synthetic.

### Item domain
- **Hero domain + graceful degradation — a positioning choice, not a caveat.** The hero domain *is* reseller inventory: books/media (ISBN), consumer electronics, video games and consoles, board games, LEGO, sneakers, branded clothing/streetwear, and branded gear. These are exactly the categories where eBay public **sold comps** are dense, so the pricing tier is genuinely strong and the suggestion is defensible. We concentrate there on purpose rather than chasing a "price anything" guarantee. Generic household items still flow through the same pipeline but honestly show low confidence. Demo arc: exact barcode → researched sold comps → correctly-flagged generic.

### eBay adapter (real, built behind interface, later phase)
- **Posting:** eBay Sell API publish (sandbox first → production).
- **Messaging:** the shared foreground/background sync service calls `GetMemberMessages` for unanswered active-listing questions, resolves the Commerce Message API conversation, writes through tenant-scoped RLS persistence, and lets **Supabase Realtime** update the frontend. Approved exact-question replies use `AddMemberMessageRTQ`; later seller-authored text uses Commerce `sendMessage`. Overlapping windows are deduplicated and the normal ingestion target is no more than five minutes.
- **Demo messaging:** seeded/simulated buyer messages remain available for a credential-free demonstration and use an explicitly simulated adapter; they never masquerade as an eBay delivery.
- **Account-deletion notification endpoint:** route stubbed from day one; fully implemented only at the production flip (required before first production call since we persist data).
- **Secrets:** app-level eBay creds in v1 (sandbox); **per-user encrypted OAuth tokens** when the real adapter lands.

### Eval & observability
- **Log every run's predictions from day one** (extracted attributes, chosen price, range, confidence, tier fired, model). Prerequisite for evaluation.
- **Lightweight-but-real eval harness** over a fixed gold set (~30–50 hero-domain items): ID field accuracy, pricing-within-band (median error + % within band), **confidence calibration** (reliability bucketing), and **listing quality** via a *validated* LLM-judge rubric. Script first; CI later (Phase 4). Gold set doubles as demo set and overlaps the seed corpus.

### Deploy
- **Vercel** (Next.js App Router + TypeScript). Docker/CI/observability layered in Phase 4 as Boot.dev coursework lands.

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
- **RLS / tenancy** — integration tests asserting a user cannot read/write another user's
  items/listings/messages/photos. Security-critical; tested at the data-access seam.
- **eBay adapter** — tested against a **stub/mock adapter** (the interface), not live eBay, so the
  pipeline is testable offline and the sandbox↔production flip is a config concern.
- **Eval harness** — itself validated: the LLM-judge is checked against a small human-labeled subset
  so we're not trusting an unvalidated judge.

**Prior art:** none yet (greenfield). Establish the patterns above as the reference for later tests.

## Out of Scope

- Auto-posting to Poshmark / Mercari / Facebook / OfferUp (no public write APIs → **export packs**; never scraping **to post**). Read-only scraping of eBay's PUBLIC *sold* pages for price research is in scope (ADR-0001) — the prohibition is on automating *posting* via scraping, not on reading public price data.
- Cross-platform unified inbox / order tracking (no APIs → eBay-only for live messaging).
- Sold-price *APIs* (gated eBay Marketplace Insights) and eBay **Browse** API (dropped). Sold-price *data* is obtained instead by scraping eBay's PUBLIC sold pages (ADR-0001).
- Real users / growth / marketing as a success metric (showcase first).
- Payment, checkout, shipping (these stay on eBay).
- A universal "price anything" guarantee — accuracy concentrates on the hero domain; generics are honestly low-confidence.
- Automatic publish after seller-triggered identity correction — regeneration always returns to a
  reviewable draft.

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
- **Phase 0 — setup:** repo, Next.js + TS, Supabase (Auth + Postgres + pgvector + Storage), env-config, secrets, OpenAI + Tavily/Exa keys, eBay sandbox keys.
- **Phase 1 — core demo (centerpiece):** photo → vision identify + attributes → pricing (start with most-reliable tier, widen) → generated listing → review/edit UI → persist. Behind Auth + RLS, deployed early.
- **Phase 2 — agentic:** confidence-gated publish eligibility; buyer-Q&A agent on simulated messages + Realtime inbox.
- **Phase 3 — posting + export:** eBay Sell API publish (sandbox); FB Marketplace + Mercari export packs.
- **Phase 4 — go real + polish:** production checklist (account-deletion endpoint, per-user OAuth, credential flip), pgvector eval polish, eval harness in CI, Docker/observability (as Boot.dev lands), README.
