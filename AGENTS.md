# SnapList — Agent Guide

Read `PRD.md` first — it is the source of truth for *what* we build and *why*. This file is *how*
to work in the repo. `PROJECT_BRIEF.md` is origin/narrative context only and is superseded by the PRD
where they disagree.

## What this is
A production-real AI-engineering showcase: photo of a used item → priced, ready-to-post listing →
(later) buyer-Q&A. The **AI pipeline is the product**; eBay is a real integration but lives behind an
adapter and is **not on the Phase 1 critical path**.

## Non-negotiable decisions (don't relitigate without the user)
- **Multi-tenant from day one:** Supabase Auth, `user_id` on every domain table, Postgres **RLS**
  enforces isolation. Never write a query path that bypasses tenant isolation.
- **OpenAI via the Vercel AI SDK.** All model calls go through the SDK; provider stays swappable.
  Structured output via `generateObject` + **Zod** — no ad-hoc JSON parsing of model output.
- **Pricing is a routing pipeline behind a `PricingProvider` interface** (ISBN lookup → web-search
  agent → depreciation → LLM fallback). Every result is `{ suggested, range, confidence, sources[] }`
  and is user-editable. Never collapse this to a single source.
- **Confidence is a signal-based composite** (tier fired + comp agreement + ID completeness), **never**
  raw LLM self-report. The autopilot gate is a threshold on it.
- **Barcode tier split:** ISBN → true structured lookup; UPC → identification/query aid into the
  search agent, not a price source.
- **Env-configurable everything.** Sandbox→production is a credential / `EBAY_BASE_URL` flip.
- **eBay only ever touched through its adapter interface.** In v1 it's sandbox/stubbed; messaging is
  simulated. Keep the pipeline testable offline against a mock adapter.
- **Log every pipeline run's predictions** (attributes, price, range, confidence, tier, model) from
  day one — the eval harness depends on it.

## How we build
- **Tracer-bullet + TDD.** Thin end-to-end threads: one or two backend pieces + minimal frontend to
  exercise them + tests, proven working before the next. No full-backend-then-frontend; no
  layer-by-layer. Always keep something that runs.
- **Test external behavior at the highest seam**, not implementation details. Key seams: the
  `PricingProvider` router (stub providers, assert tier selection), the **pure confidence function**
  (unit-test directly with crafted signals), vision/listing **contract** tests (output validates
  against schema / platform constraints), **RLS tenancy** integration tests, and the **mock eBay
  adapter**. Model *quality* is measured by the eval harness, not brittle exact-match unit tests.
- Validate the LLM-judge against a small human-labeled subset before trusting it.

## Stack
Next.js (App Router) + TypeScript · Vercel AI SDK + OpenAI · Tavily (primary) / Exa (secondary) web
search · Supabase (Postgres + pgvector + Auth + Realtime + Storage + cron) · Zod · Tailwind +
shadcn/ui · Vercel deploy · eBay Sell + Trading APIs (sandbox → production, via adapter).

## Conventions
- Confirm current OpenAI model IDs against live docs before hardcoding — they move fast.
- Secrets via env; never commit keys. v1 eBay creds app-level; per-user **encrypted** OAuth tokens
  when the real adapter lands.
- For non-trivial UI work, use the Open Design workflow (see the user's global instructions) rather
  than hand-writing large CSS/JSX blind.
- Keep `PRD.md` updated when a decision changes; keep this file's "non-negotiables" in sync.

## Item domain
Hero domain (books/media via ISBN, electronics, board games, branded gear) works well; generic items
flow through but honestly show low confidence. Don't chase universal coverage.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `azizu06/snaplist` (use the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, default names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
