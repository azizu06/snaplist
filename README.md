# SnapList

Snap a photo of a resale item → get a priced, ready-to-post marketplace listing. SnapList prefers
real sold comps when available, then falls back to cited web sources or clearly labeled estimates,
always with a confidence score. Built for resellers; a production-real AI-engineering showcase.

> **Docs:** [`PRD.md`](./PRD.md) is the source of truth for what we build · [`CONTEXT.md`](./CONTEXT.md)
> is the domain glossary · [`AGENTS.md`](./AGENTS.md) is the agent/engineering guide ·
> [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) is origin context (superseded by the PRD). See
> [`docs/`](./docs) for ADRs, architecture, marketplace setup, security, and strategy notes.

## What it is
Resellers list in volume, and the per-item work doesn't scale: for every flip — thrift finds,
sneakers, streetwear, electronics, games, LEGO — you photograph it, research what it actually
*sold* for used (not retail, not the optimistic asking price), write a platform-appropriate listing,
post it, then answer the same buyer questions over and over. Real *sold* prices are the hard part,
and retail prices mislead for used goods. Multiply that by a haul and the research alone eats the day.

SnapList collapses that into a photo plus a couple of approvals so a reseller can clear a whole haul
in one pass. The seller snaps 1–4 photos; the system identifies the item (brand, model, category,
condition, specs, any barcode/ISBN), researches a defensible price range from real sold comps when
available and cited fallback sources otherwise, writes per-platform listing copy, and shows it for
review. Before publishing, the seller can correct the load-bearing identity facts and explicitly
re-price and regenerate a coherent draft without losing a saved price override. High-confidence
items can post automatically (a confidence-gated autopilot); low-confidence
ones queue for review. Listings publish to eBay behind an adapter, with copy-paste export packs for
Facebook Marketplace and Mercari, and a buyer-Q&A agent drafts grounded replies the seller approves.
Clearing a whole haul? **Bulk capture** takes item after item in one session through the same
pipeline and lands on a live triage list of the batch. SnapList is the seller's **control surface** —
payment, checkout, and shipping stay on eBay; buyers never see it.

This repo is built as a **production-real AI-engineering showcase**: the AI pipeline *is* the product,
and the goal is the full stack working end-to-end in a deployed app. The
[skills-on-display map](#skills-on-display) shows where each technique lives.

## Architecture
One spine, seen three ways: **which pricing tier fired → the confidence composite → eval
calibration.** A photo becomes Zod-validated attributes; the pricing router walks its tiers in
priority order and returns the first that handles the item; a signal-based confidence score (never an
LLM self-report) gates the autopilot; and every run is logged for the eval harness.

```mermaid
flowchart TD
    subgraph seller["Seller surface · Next.js App Router · Clerk auth"]
        UP["Snap 1–4 photos"]
        REVIEW["Review, edit, approve"]
        CORRECT["Correct identity<br/>re-price + regenerate"]
        INBOX["Buyer Q&A inbox (Realtime)"]
    end

    UP --> STORE["Supabase Storage<br/>user-scoped paths · RLS"]
    STORE --> VISION

    subgraph pipeline["AI pipeline · src/lib"]
        VISION["Vision extraction<br/>1 multimodal generateObject call<br/>Zod attributes · flags ambiguity"]
        ROUTER["PricingProvider router<br/>tries tiers in order, first wins"]
        CONF["Confidence composite<br/>tier fired + comp agreement + ID completeness"]
        GATE{"Autopilot gate"}
        LISTING["Listing generation<br/>per-platform copy · RAG few-shot"]
    end

    VISION --> ROUTER

    subgraph tiers["Pricing tiers · PRD priority order"]
        T1["1 · ISBN lookup<br/>Open Library + Google Books"]
        T2["2 · eBay PUBLIC sold comps<br/>completed-sale scrape"]
        T3["3 · UPC-aided web search<br/>Tavily / Exa agent"]
        T4["4 · Branded web search<br/>Tavily / Exa agent"]
        T5["5 · Depreciation<br/>retail x condition factor"]
        T6["6 · LLM-only floor<br/>never declines"]
        T1 -->|declines| T2 -->|declines| T3 -->|declines| T4 -->|declines| T5 -->|declines| T6
    end

    ROUTER --> T1
    ROUTER -->|"first priced result: suggested, range, confidence, sources"| CONF
    CONF --> GATE
    GATE -->|high confidence| LISTING
    GATE -->|low confidence| REVIEW
    REVIEW --> LISTING
    REVIEW -->|fix facts before publish| CORRECT
    CORRECT -->|re-price corrected facts| ROUTER
    CORRECT -->|regenerate grounded copy| LISTING

    LISTING --> EBAY["eBay adapter<br/>Sell API · sandbox → prod flip"]
    LISTING --> EXPORT["Export packs<br/>Facebook Marketplace · Mercari"]
    EBAY --> LIVE["Live eBay listing"]

    INBOX --> QA["Buyer-Q&A agent<br/>grounded draft reply"]
    QA --> QAPPROVE["Seller approves or edits reply"]
    QAPPROVE --> DELIVER["Deliver to buyer (simulated in v1)"]

    subgraph crosscut["Cross-cutting"]
        REG["LLM provider registry<br/>Gemini dev / OpenAI showcase"]
        RAG["pgvector reference corpus<br/>grounds copy · corroborates price"]
        LOGS["prediction_logs<br/>attrs · price · tier · confidence per run"]
        EVAL["Eval harness<br/>ID accuracy · price band · calibration"]
        OBS["Observability<br/>structured JSON · /api/health"]
    end

    VISION -.->|resolveLanguageModel| REG
    LISTING -.-> REG
    QA -.-> REG
    ROUTER -.->|corroboration| RAG
    LISTING -.->|few-shot| RAG
    CONF -.->|logs prediction| LOGS
    LISTING -.->|run events| OBS
    LOGS --> EVAL
```

**Reading the diagram.** Photos land in user-scoped Supabase Storage (RLS). A single multimodal
`generateObject` call extracts attributes and *flags* anything ambiguous instead of guessing. The
`PricingProvider` router tries six tiers in priority order and returns the first that handles the
item, always shaped as `{ suggested, range, confidence, sources[] }`. The confidence composite —
tier fired + comp agreement + identification completeness — drives the autopilot gate: high
confidence is eligible to auto-post, everything else queues for review. Approved listings publish to
eBay through the adapter (sandbox today; a credential flip to production) and render copy-paste export
packs for Facebook Marketplace and Mercari. Buyer questions arrive in a Realtime inbox where a
grounded agent drafts a reply for the seller to approve. Cutting across all of it: a role-keyed LLM
provider registry (Gemini in dev, OpenAI for the showcase), a pgvector reference corpus that grounds
copy and corroborates price, per-run prediction logs feeding the eval harness, structured-JSON
observability, and Clerk auth with Postgres RLS enforcing per-user isolation everywhere.

The pre-publish correction loop replaces bounded identity facts (brand, model, category, condition,
valid ISBN/UPC, and relevant specifications), then reruns pricing, confidence, and listing generation.
Its RLS-scoped transaction atomically advances the item, eBay draft, and prediction log, preserves a
saved seller price override, invalidates stale export packs, rejects stale/live review state, and never
publishes automatically.

> This diagram tracks the current build and will keep maturing with the project — the messaging
> delivery path is simulated in v1, and the production eBay poller/queue lands with the go-live work
> ([#17](https://github.com/azizu06/snaplist/issues/17), [#65](https://github.com/azizu06/snaplist/issues/65)).

## Stack
Next.js (App Router) + TypeScript · Vercel AI SDK + OpenAI · Tavily/Exa web search · Supabase
(Postgres + pgvector + Auth + Realtime + Storage) · Zod · Tailwind + shadcn/ui · Vercel · eBay
Sell/Trading APIs (sandbox → production, behind an adapter) · Docker + GitHub Actions.

## Getting started
```bash
pnpm install
cp .env.example .env.local   # fill in keys
pnpm supabase start          # local Supabase stack (needs Docker)
pnpm dev                     # http://localhost:3000
```

## Scripts
| Command | What |
|---|---|
| `pnpm dev` | Run the app (Turbopack) |
| `pnpm build` | Production build (works with **no secrets** — env validation is lazy) |
| `pnpm test` | Run unit/contract tests (Vitest) |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm smoke:sold-comps` | Offline sold-comps egress/router smoke (0 requests by default; [operator procedure](./docs/sold-comps-egress.md)) |
| `pnpm eval` | Eval harness — offline by default (see below) |
| `pnpm supabase` | Supabase CLI |

## How we build
Tracer-bullet development with TDD — thin end-to-end threads, tested at the highest seam, proven
before the next. See [`AGENTS.md`](./AGENTS.md) and [`docs/agents/`](./docs/agents).

## Skills on display
The pipeline spine — *which pricing tier fired → confidence composite → eval calibration* — is one
idea seen three ways. The map from skill to code:

| Skill | Where |
|---|---|
| Multimodal vision extraction | `src/lib/vision` — one `generateObject` call over the photos → Zod-validated attributes + flagged identification |
| Agents + tool calling | `src/lib/pricing/providers` (web-search pricing agent over Tavily/Exa) · `src/lib/inbox` (grounded buyer-Q&A reply agent) |
| RAG + pgvector | `src/lib/rag` — seeded reference corpus, HNSW + cosine via the `match_reference_corpus` RPC; one retrieval feeds pricing corroboration **and** few-shot listing copy |
| Pricing as a routing pipeline | `src/lib/pricing/router.ts` — ISBN lookup → eBay sold comps → UPC-aided web → branded web → depreciation → LLM fallback, every result `{ suggested, range, confidence, sources[] }` |
| Signal-based confidence (never LLM self-report) | `src/lib/confidence` — pure composite of tier fired + comp agreement + ID completeness; gates the autopilot |
| Structured outputs | Zod everywhere a model speaks: `src/lib/pipeline/types.ts`, `src/lib/listing/schema.ts` — no ad-hoc JSON parsing |
| Prompt/context engineering | `src/lib/listing` + `src/lib/export` — per-platform copy generation, used-vs-new disambiguation |
| Coherent human correction loop | `src/lib/pipeline/review-regeneration.ts` + the review RPCs — bounded identity edits, shared pricing/confidence/listing seams, revision guards, atomic RLS persistence, stale export invalidation |
| Evals + calibration | `src/lib/eval` — gold set, ID/pricing metrics, reliability buckets + ECE, LLM judge validated against human labels |
| Security | Clerk auth (Supabase third-party JWTs) + RLS on every domain table (tested in `src/lib/supabase/rls.test.ts` against minted tokens), user-scoped storage paths, lazy env validation (`src/lib/env.ts`), eBay account-deletion endpoint |
| Marketplace integration behind an adapter | `src/lib/marketplace` (eBay Sell API, sandbox) · export packs for FB Marketplace/Mercari |
| Docker / CI / observability | `Dockerfile`, `.github/workflows/ci.yml`, `src/lib/observability.ts`, `/api/health` |

## Eval harness
`pnpm eval` is **offline by default**: it scores the checked-in sample predictions against the
~36-item gold set (`src/lib/eval/fixtures/`) with a deterministic heuristic judge — no network, no
keys, no database. The report covers identification accuracy, price-band accuracy, confidence
calibration (reliability buckets + ECE), and judged listing quality; every run also validates the
active judge against a small human-labeled subset. Flags opt into the real world:

```bash
pnpm eval                       # offline: fixtures + heuristic judge (what CI runs)
pnpm eval --db                  # score real logged runs from Supabase (service-role key required)
pnpm eval --real-judge          # LLM judge instead of the heuristic (OPENAI_API_KEY)
pnpm eval --predictions f.json  # score an arbitrary predictions file
```

## Eval results
Headline numbers from the gold set, populated once the eval-metrics work
([#61](https://github.com/azizu06/snaplist/issues/61)) lands. Until then, run `pnpm eval` for the
live offline report.

| Metric | Value |
|---|---|
| Identification accuracy (field-level) | _TODO (#61)_ |
| Pricing within band (% of items) | _TODO (#61)_ |
| Median price error | _TODO (#61)_ |
| Confidence calibration (ECE) | _TODO (#61)_ |

> These measure pipeline consistency against authored gold labels, **not** field accuracy against
> real sold prices — see [Honest accuracy ceiling](#honest-accuracy-ceiling).

## CI
`.github/workflows/ci.yml` runs on every push/PR to `main`, with **no secrets**:
frozen-lockfile install → `pnpm typecheck` (vitest does not typecheck) → `pnpm test` →
`pnpm eval` (offline path) → `pnpm build`. DB-gated integration tests (the RLS tenancy suite)
detect the missing local Supabase stack and skip gracefully — they run locally against
`pnpm supabase start`.

## Docker
Multi-stage build (deps → build → standalone runner, non-root). The image build needs **no
secrets**; runtime config is injected when the container starts:

```bash
docker build -t snaplist .
docker run --rm -p 3000:3000 --env-file .env.local snaplist
```

The container exposes port 3000 and self-reports liveness via a `HEALTHCHECK` against
`GET /api/health` → `{ "ok": true }`.

## Observability
Deliberately minimal — structured JSON lines to stdout (`src/lib/observability.ts`), no APM vendor,
no new env: every pipeline run emits a timed `pipeline.run` event (duration, outcome) and a
`pipeline.persisted` summary (run/item/listing ids, tier fired, confidence score/band, gated
status). Identifiers and signals only — never photo contents or listing copy. Liveness:
`GET /api/health`. Every run's predictions are also persisted to `prediction_logs` for the eval
harness — the durable observability layer.

## Reference corpus (RAG / pgvector)
SnapList ships a **seeded reference corpus** to avoid RAG cold-start (PRD "RAG (pgvector)"). It is
**global, read-only reference data** — *not* per-user — so it lives in its own `reference_corpus`
table (no `user_id`), distinct from the per-user `embeddings` table. RLS grants **read to all
authenticated users and no write** to app roles; seeding is done with the service role. Retrieval
(`src/lib/rag`) serves two consumers from one similarity query: **(a)** a pricing-corroboration
signal (matched comps' median/range/dispersion) that feeds the confidence composite, and **(b)**
few-shot example copy for the listing generator. Vector search uses pgvector HNSW + cosine via the
`match_reference_corpus` RPC.

Embedding generation is **pluggable**: real OpenAI `text-embedding-3-small` vectors when
`OPENAI_API_KEY` is set at seed time, else deterministic offline-safe synthetic vectors (which is
what the offline retrieval tests use). Seed the corpus into a running local stack with:

```bash
# env from `pnpm supabase status -o env` (map API_URL/SERVICE_ROLE_KEY → SUPABASE_URL/…ROLE_KEY)
pnpm exec tsx supabase/seed/reference-corpus.ts
```

## Honest accuracy ceiling
Being able to state where the system's accuracy tops out is part of the showcase:

- **Pricing is bounded by its data and egress.** The preferred `ebay-sold` tier reads real completed
  sales from eBay's public sold pages when the environment can reach them and enough relevant comps
  exist. Hosted egress can be blocked or a query can be too thin; in those cases the router falls
  through to cited web search (often *asking* prices), depreciation, or the LLM-only floor. The
  corpus-corroboration signal is built on synthetic comps. Treat every price as a *smart
  suggestion*, not an oracle. See the [operator smoke procedure](./docs/sold-comps-egress.md).
- **The `llm-only` floor tier is a guess.** When no barcode, brand, or retail anchor resolves, the
  fallback is an LLM estimate — lowest confidence by construction, and surfaced as such.
- **The gold set is small and partly synthetic.** ~36 hand-authored hero-domain items whose price
  bands are plausible ranges, not measured sold prices. Offline eval numbers measure pipeline
  consistency against those authored labels — they are **not** a field-accuracy benchmark, and the
  default `pnpm eval` run scores a checked-in sample-predictions fixture (a harness demo).
- **Accuracy concentrates on the hero domain** (books/media via ISBN, electronics, video games,
  board games, LEGO, sneakers, and branded gear). Generic items flow through but honestly show low
  confidence — no universal
  "price anything" claim.
- **Vision is one multimodal extraction.** Ambiguous identifications are *flagged* (with
  candidates), not solved.

## Synthetic-data disclosures
- **Reference corpus:** realistic-synthetic — hand-authored, hero-domain-weighted example items
  with plausible used/resale prices and good listing copy, **not** scraped real listings or live
  sold-price comps. The retrieval architecture is real; only the seed content is synthetic.
- **Eval gold set + sample predictions:** hand-authored fixtures (overlapping the corpus via
  `sourceRef`), labeled for development — see the accuracy-ceiling notes above.
- **Buyer traffic is simulated.** The inbox's buyer questions come from a simulation endpoint, not
  real marketplace buyers; the reply agent is real and grounded in the item's actual data.
- **eBay is sandbox.** Publishing targets the eBay sandbox (`EBAY_BASE_URL` flip to production by
  design, see [`docs/ebay-sandbox.md`](./docs/ebay-sandbox.md)); no live marketplace listings are
  created.
