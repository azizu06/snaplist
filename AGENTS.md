# SnapList — Agent Guide

Read `PRD.md` first — it is the source of truth for *what* we build and *why*. This file is *how*
to work in the repo. `PROJECT_BRIEF.md` is origin/narrative context only and is superseded by the PRD
where they disagree.

## What this is
A production-real AI-engineering showcase: photo of a used item → priced, ready-to-post listing →
buyer-Q&A. The **AI pipeline is the product**; eBay is a real integration but lives behind an
adapter and is **not on the Phase 1 critical path**.

## Non-negotiable decisions (don't relitigate without the user)
- **Multi-tenant from day one:** Clerk auth (Supabase third-party JWTs; issue #41), text `user_id`
  (the Clerk id) on every domain table, Postgres **RLS** enforces isolation via
  `public.clerk_user_id()`. Never write a query path that bypasses tenant isolation.
- **Vercel AI SDK behind a role-keyed provider registry** (`src/lib/llm`, ADR-0002). All model
  calls resolve through `resolveLanguageModel(role, …)`; the provider is a `LLM_PROVIDER` flip
  (dev → Gemini for the free tier, showcase → OpenAI) — never construct a provider inline at a call
  site. Structured output via `generateObject` + **Zod** — no ad-hoc JSON parsing of model output.
  Embeddings are excluded from the switch (pgvector `vector(1536)` dimension lock).
- **Pricing is a routing pipeline behind a `PricingProvider` interface** (ISBN lookup → **eBay public
  sold comps** → web-search agent → depreciation → LLM fallback; see `docs/adr/0001`). Every result is
  `{ suggested, range, confidence, sources[] }` and is user-editable. Never collapse this to a single
  source. The eBay-sold scraper is **read-only price research** — distinct from the transactional eBay
  **adapter**, which remains the only path for posting/messaging. Sold prices are **live-fetched**
  (cache-on-miss + age-decay, #59); the pgvector corpus is never the price oracle. Sold-comps egress
  is best-effort: direct fetch is the default, an optional proxy template is validated before use,
  and blocked/thin results fall through. Every evidence-backed tier cites sources; only the clearly
  labeled terminal `llm-only` estimate may return an empty `sources[]`.
- **One effective price governs every outbound path.** A usable, cent-normalized
  `items.price_override` wins over the latest `prediction_logs.price`; eBay publish and every
  Facebook/Mercari export pack (including cached packs) must use that shared precedence. Prediction
  logs remain recommendation/eval history, never the seller's chosen price. Reject invalid override
  writes, ignore invalid legacy overrides on reads, and advance `review_revision` whenever the
  override changes so publish/export revision guards fail closed.
- **Confidence is a signal-based composite** (tier fired + comp agreement + ID completeness), **never**
  raw LLM self-report. The publish-eligibility gate is a threshold on it; eligibility never publishes.
- **Barcode tier split:** ISBN → true structured lookup; UPC → identification/query aid into the
  search agent, not a price source.
- **Env-configurable everything.** Sandbox→production is a credential / `EBAY_BASE_URL` flip.
- **eBay marketplace mutations and messaging only ever go through the adapter interface.** The one
  non-transactional exception is read-only public sold-page research through `ebay-sold`; it cannot
  post or message. Publishing and pre-sale text messaging are Sandbox-capable; the simulator remains
  a demo fixture. Keep every path testable offline against mock adapters, and leave production
  activation owner-controlled under #17.
- **Log every pipeline run's predictions** (attributes, price, range, confidence, tier, model) from
  day one — the eval harness depends on it.
- **Review correction stays coherent and pre-publish.** Bounded identity edits must rerun the shared
  pricing router, composite confidence, and grounded listing generator, then atomically persist the
  item, eBay draft, and prediction log under RLS. Preserve seller price overrides, invalidate stale
  export packs, reject stale or authoritative publishing/published state, and never auto-publish.

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
Next.js (App Router) + TypeScript · Vercel AI SDK (OpenAI showcase / Gemini dev, via a role-keyed
provider registry) · Tavily (primary) / Exa (secondary) web search · eBay public sold-page scraper
(cheerio) · Clerk (auth) · Supabase (Postgres + pgvector + Realtime + Storage + cron) · Zod · Tailwind +
shadcn/ui · Vercel deploy · eBay Sell + Trading APIs (sandbox → production, via adapter).

## Conventions
- Confirm current OpenAI model IDs against live docs before hardcoding — they move fast.
- Secrets via env; never commit keys. Transactional eBay calls use per-user **encrypted** OAuth
  tokens; the app-level Sandbox fallback is restricted to one configured operator tenant/seller.
- For non-trivial UI work, use the Open Design workflow (see the user's global instructions) rather
  than hand-writing large CSS/JSX blind.
- **Mutation seams:** views mutate through **server actions**; API routes serve external/programmatic
  callers (and client fetch flows like the inbox that need JSON/streaming). When an operation has both
  entry points, ALL domain behavior (persistence, notifications) lives in the shared `src/lib` service
  (e.g. `publishListingToEbayAndNotify`) so the two can never diverge.
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

## Build tracking

Work is decomposed into vertical-slice (tracer-bullet) issues on the **GitHub Project "SnapList Build"**
(project #2 — <https://github.com/users/azizu06/projects/2>). View it as a Kanban board grouped by the
**`Lane`** field (Backlog · Ready · Blocked · In progress · In review · Done); a **`Phase`** field (0–4)
gives a second cut. Dependencies are encoded as `Blocked by #N` in each issue body — together the
`Blocked by` edges + the `Lane` field model the dependency DAG.

Rules:
- **Start only from `Lane = Ready`** (in-degree-0). Never start a `Blocked` issue before its blockers close.
- When a blocker closes, its dependents' in-degree drops — move them **Blocked → Ready** and pick up the
  next parallel wave. Unblocked, independent slices can be worked **in parallel**.
- Move a slice's lane to reflect reality: Ready → In progress → In review → Done.
