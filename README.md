# SnapList

Snap a photo of a used item → get a priced, ready-to-post marketplace listing, with a confidence
score and cited price sources. Production-real AI-engineering showcase.

> **Docs:** [`PRD.md`](./PRD.md) is the source of truth for what we build · [`CONTEXT.md`](./CONTEXT.md)
> is the domain glossary · [`AGENTS.md`](./AGENTS.md) is the agent/engineering guide ·
> [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) is origin context (superseded by the PRD).

## Stack
Next.js (App Router) + TypeScript · Vercel AI SDK + OpenAI · Tavily/Exa web search · Supabase
(Postgres + pgvector + Auth + Realtime + Storage) · Zod · Tailwind + shadcn/ui · Vercel · eBay
Sell/Trading APIs (sandbox → production, behind an adapter).

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
| `pnpm build` | Production build |
| `pnpm test` | Run unit/contract tests (Vitest) |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm supabase` | Supabase CLI |

## How we build
Tracer-bullet development with TDD — thin end-to-end threads, tested at the highest seam, proven
before the next. See [`AGENTS.md`](./AGENTS.md) and [`docs/agents/`](./docs/agents).

Health check: `GET /api/health` → `{ "ok": true }`.

## Reference corpus (RAG / pgvector)
SnapList ships a **seeded reference corpus** to avoid RAG cold-start (PRD "RAG (pgvector)"). It is
**global, read-only reference data** — *not* per-user — so it lives in its own `reference_corpus`
table (no `user_id`), distinct from the per-user `embeddings` table. RLS grants **read to all
authenticated users and no write** to app roles; seeding is done with the service role. Retrieval
(`src/lib/rag`) serves two consumers from one similarity query: **(a)** a pricing-corroboration
signal (matched comps' median/range/dispersion) that feeds the confidence composite, and **(b)**
few-shot example copy for the listing generator. Vector search uses pgvector HNSW + cosine via the
`match_reference_corpus` RPC.

> **Honesty disclosure:** the seeded corpus content is **realistic-synthetic** — hand-authored,
> hero-domain-weighted example items (electronics, books/media, board games, branded gear, plus a
> couple of generics) with **plausible used/resale prices and good listing copy, not scraped real
> listings or live sold-price comps.** The retrieval architecture is real; only the seed content is
> synthetic. Per-item asking prices ≠ sold prices — treat the corroboration signal as a *smart
> suggestion*, not an oracle.

Embedding generation is **pluggable**: real OpenAI `text-embedding-3-small` vectors when
`OPENAI_API_KEY` is set at seed time, else deterministic offline-safe synthetic vectors (which is
what the offline retrieval tests use). Seed the corpus into a running local stack with:

```bash
# env from `pnpm supabase status -o env` (map API_URL/SERVICE_ROLE_KEY → SUPABASE_URL/…ROLE_KEY)
pnpm exec tsx supabase/seed/reference-corpus.ts
```
