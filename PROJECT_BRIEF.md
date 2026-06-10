# SnapList — Project Brief
> Working name; rename freely. (Idea origin: Ideabrowser "Home Sale Helper" #1613.)
>
> ⚠️ **Origin/narrative context only.** Build decisions live in `PRD.md`, which supersedes this
> brief wherever they disagree (tenancy, provider, pricing tiers, barcode handling, scope, etc.).

## One-liner
An AI assistant that turns a **photo of a used household item** into a **priced, ready-to-post
marketplace listing**, then handles buyer Q&A — collapsing ~20–30 min of work per item into a
photo plus a couple of approvals.

## Pain point
Selling used stuff is a time sink: photograph it, research a fair price, write a decent listing,
post it, then answer the same buyer questions over and over. SnapList automates the
listing-creation and message-triage labor. (It does not replace the marketplace itself — payment,
checkout, and shipping still happen on eBay.)

## Framing (sets every downstream decision)
This is primarily a **resume / skill-showcase project** that we are building to be **genuinely real
(production), not a sandbox toy.** Goal: visibly demonstrate the full AI-engineering stack
end-to-end in a polished, deployed app.
- Market saturation is irrelevant (incumbents exist; fine).
- **Sandbox = development only. Production = the end goal.** (See "Path to real" below.)
- Optimize for: breadth + depth of techniques visibly used, clean architecture, a live demo, and a
  crisp interview narrative.
- Personal hook (why it gets finished): Aziz genuinely hates the used-item selling hassle.

## Skills this is designed to showcase
| Skill (cert) | Where it shows up |
|---|---|
| Multimodal AI / vision (AI Eng) | Photo → item identification + condition/attribute extraction + barcode/label reading |
| Agents + tool calling (AI Eng) | Pricing **research agent** (web search), buyer-Q&A agent, autopilot |
| RAG / synthesis (AI Eng) | Reconcile multiple web sources into a cited price range; retrieve similar past items |
| Structured outputs, Zod-validated (AI Eng + Security) | Attribute schema, listing schema, price-recommendation schema |
| Prompt / context engineering (AI Eng) | Per-platform listing generation; used-vs-new price disambiguation |
| Vector DB / pgvector (AI Eng) | Similar-item retrieval to ground pricing + copy |
| Security (Cybersecurity cert) | eBay OAuth, secret handling, input validation, account-deletion endpoint |
| Docker / CI / observability / deploy (Boot.dev, later) | Phase 4, as those courses complete |

## Core flow ( [auto] = agent, [tap] = user )
1. [tap] Snap photo(s) of the item — the only required input.
2. [auto] Vision → brand, model, category, condition, key specs, any barcode/ISBN (structured output).
3. [auto] **Pricing research agent** → suggested price + range + confidence + sources (see strategy below).
4. [auto] Listing generator → title, item specifics, description, tags (per-platform).
5. [tap] Review & approve (or edit price/fields).
6. [auto] Post to eBay (Sell API); generate copy-paste **export packs** for other platforms.
7. [auto] Buyer message → agent drafts reply; [tap] approve send.

**Signature feature — confidence-gated autopilot:** the agent scores its own identification/pricing
confidence. High-confidence items post automatically; low-confidence ones queue for review.

## Pricing strategy (the hard part — broad + "good enough" accurate)
Pricing is a **routing pipeline behind a `PricingProvider` interface**, not a single source:
1. **Barcode / ISBN present** (books, media, packaged goods) → structured lookup (most accurate).
2. **Recognizable branded item** → **web-search pricing agent** (Tavily / Exa / Perplexity Sonar):
   formulate queries → search the open web for *used/sold/resale* prices → synthesize a cited range.
3. **Generic item, only retail found** → retail price × **condition-based depreciation factor**
   (labeled as an estimate, low confidence).
4. **Ultimate fallback** → LLM-only estimate.

Every result carries **suggested + range + confidence + sources**, and is **user-editable**.
- eBay **Browse** API is **dropped** (only gives asking prices, needs uncertain Buy-API approval).
- eBay **Marketplace Insights** (true *sold* prices) is **gated/unavailable** to solo devs — not used.
- Accuracy concentrates where it matters: valuable/branded items have rich web comps; cheap generic
  items get rough estimates (low stakes). Honest ceiling: this is a *smart suggestion*, not an oracle.

## Messaging architecture (Phase 2)
SnapList is a **seller's control surface over eBay messaging**, not a chat platform. Buyers stay on
eBay; only the seller (user) lives in SnapList.
- **Backend cron** (every ~60s) calls eBay `GetMyMessages` for the linked account → writes new
  messages to our DB. (Polling, not webhook — eBay doesn't reliably push member messages.)
- **Frontend** reads from DB via **Supabase Realtime** subscription → inbox updates live on screen.
- Buyer-Q&A agent drafts a reply → user approves → `AddMemberMessageRTQ` delivers it to the buyer's
  eBay inbox. Buyer never sees SnapList.
- For the demo, seed **simulated** buyer messages (sandbox has no real buyer traffic).

## Architecture
```
[Next.js PWA] camera/upload → review & edit UI (streaming)
      |
[API routes / server actions]
      |
 ┌────┴───────────────┬──────────────────────┬─────────────────────┐
[Vision+Attributes]   [Pricing Agent]         [Listing Generator]   [(P2) Buyer Agent]
 multimodal LLM →      web-search tool +       LLM + structured       Vercel AI SDK
 Zod-validated         routing pipeline →      output per platform    tool-calling
 attributes+barcode    {price, range, conf,                           + cron poller
                        sources}
      |
[Supabase: Postgres + pgvector]  items, listings, messages, embeddings (similar-item RAG)
      |
[Vercel deploy]  +  [eBay account-deletion notification endpoint]
```

## Scope by phase
- **Phase 0 — setup:** repo, Next.js + TS, Supabase, env-config (`EBAY_BASE_URL` etc.), secrets, LLM
  provider, web-search API key, eBay **sandbox** dev keys.
- **Phase 1 — core demo (centerpiece):** photo → vision identify + attributes → pricing agent →
  generated listing → review/edit UI → persist. (eBay posting against sandbox.)
- **Phase 2 — agentic:** buyer-Q&A agent + cron poller + Realtime inbox; confidence-gated autopilot.
- **Phase 3 — posting + export:** eBay Sell API publish (sandbox); export packs for other platforms.
- **Phase 4 — go real + polish:** production checklist (below), pgvector similar-item RAG, eval suite
  (ID accuracy + pricing sanity), Docker/CI/observability (as Boot.dev lands), deploy, README.

## Path to real (sandbox → production)
Build **env-configurable** so production is a credential flip, not a rewrite. To go live:
- [ ] Implement eBay **Marketplace Account Deletion** notification endpoint (required before first
      production call; can't opt out since we persist data).
- [ ] Generate production keyset; wire **per-user OAuth** to real eBay accounts + business policies.
- [ ] Pricing already works in production (web-search agent — no eBay approval needed).
- [ ] Flip `EBAY_BASE_URL` / keys → real.

## Explicit non-goals
- Auto-posting to Poshmark/Mercari/Facebook/OfferUp (no public APIs → **export packs**, never scraping).
- Cross-platform inbox/tracking (no APIs → eBay-only).
- True sold-price data (gated API) and eBay Browse (dropped).
- Real users / growth / marketing as a success metric (it's a showcase first).

## Tech stack
Next.js (App Router) + TypeScript · Vercel AI SDK · OpenAI `gpt-4o` (vision + generation) [or Claude] ·
web search via Tavily / Exa / Perplexity Sonar · Supabase (Postgres + pgvector + auth + Realtime + cron) ·
Zod · Tailwind + shadcn/ui (via Open Design) · Vercel deploy · eBay Sell + Trading APIs (sandbox → production).

## Success criteria
- End-to-end flow works on a live URL (production-real, not just sandbox).
- Every listed skill visibly exercised and documented in the README.
- Clean architecture: pricing behind a swappable interface, agent with confidence gating, eval suite.
- A one-line resume bullet + a 2-minute interview walkthrough fall out naturally.

## Open setup items (to start Phase 0)
- LLM provider + API key (default: OpenAI `gpt-4o`).
- Web-search provider (Tavily / Exa / Perplexity — Aziz already has Tavily + Exa).
- Confirm repo location/name (currently `~/projects/snaplist`).
