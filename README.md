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
