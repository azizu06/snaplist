# SnapList

Snap a photo of a used item → get a priced, ready-to-post marketplace listing, with a confidence
score and cited price sources. Production-real AI-engineering showcase.

> **Docs:** [`PRD.md`](./PRD.md) is the source of truth for what we build · [`CONTEXT.md`](./CONTEXT.md)
> is the domain glossary · [`AGENTS.md`](./AGENTS.md) is the agent/engineering guide ·
> [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) is origin context (superseded by the PRD).

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
| Pricing as a routing pipeline | `src/lib/pricing/router.ts` — ISBN lookup → UPC-aided web → branded web → depreciation → LLM fallback, every result `{ suggested, range, confidence, sources[] }` |
| Signal-based confidence (never LLM self-report) | `src/lib/confidence` — pure composite of tier fired + comp agreement + ID completeness; gates the autopilot |
| Structured outputs | Zod everywhere a model speaks: `src/lib/pipeline/types.ts`, `src/lib/listing/schema.ts` — no ad-hoc JSON parsing |
| Prompt/context engineering | `src/lib/listing` + `src/lib/export` — per-platform copy generation, used-vs-new disambiguation |
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

- **Pricing is bounded by its data.** There is no true sold-price source in v1 (eBay Marketplace
  Insights is gated; dropped). Web tiers price from live *asking* prices, and asking ≠ sold. The
  corpus-corroboration signal is built on synthetic comps. Treat every price as a *smart
  suggestion*, not an oracle.
- **The `llm-only` floor tier is a guess.** When no barcode, brand, or retail anchor resolves, the
  fallback is an LLM estimate — lowest confidence by construction, and surfaced as such.
- **The gold set is small and partly synthetic.** ~36 hand-authored hero-domain items whose price
  bands are plausible ranges, not measured sold prices. Offline eval numbers measure pipeline
  consistency against those authored labels — they are **not** a field-accuracy benchmark, and the
  default `pnpm eval` run scores a checked-in sample-predictions fixture (a harness demo).
- **Accuracy concentrates on the hero domain** (books/media via ISBN, electronics, board games,
  branded gear). Generic items flow through but honestly show low confidence — no universal
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
