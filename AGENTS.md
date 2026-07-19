# SnapList — Agent Guide

Read `PRD.md` first — it is the source of truth for *what* we build and *why*. This file is *how*
to work in the repo. `PROJECT_BRIEF.md` is origin/narrative context only and is superseded by the PRD
where they disagree.

## What this is
A production-real AI-engineering showcase: photo of a used item → priced, ready-to-post listing →
buyer-Q&A. The **AI pipeline is the product** for the average consumer reseller; eBay is the only
direct launch marketplace and lives behind adapters. Advanced volume workflows are a growth path,
not the default product posture.

## Non-negotiable decisions (don't relitigate without the user)
- **Multi-tenant from day one:** Clerk auth (Supabase third-party JWTs; issue #41), text `user_id`
  (the Clerk id) on every domain table, Postgres **RLS** enforces isolation via
  `public.clerk_user_id()`. Never write a query path that bypasses tenant isolation.
- **First value precedes account creation.** One App Attest-backed guest allowance includes exactly
  one complete AI item run and one guided identity correction for the same item/photo set; manual
  edits that preserve the immutable photo-set fingerprint, technical retries, recovery, and queue
  redelivery do not consume another credit. Adding, replacing, or removing a photo changes the photo
  set and requires a new run. The usable
  result remains encrypted and recoverable for 24 hours. Account creation/eBay connection become
  blocking only when the guest chooses **Publish to eBay**, after which the same result is claimed
  and reopened. Pre-value onboarding has no seller questionnaire. See ADR-0008.
- **AI-item credits settle on durable value.** The first usable listing and first seller-confirmed
  eBay publish are free. SnapList Pro gates complete AI item run #2 and uses a configurable monthly
  allowance whose public count waits for TestFlight median/p95 cost data. For monthly Apple billing,
  the verified StoreKit transaction span is the reset window; for annual billing, the server derives
  monthly subperiods inside the signed annual span from verified transaction dates and identity.
  Verified grace keeps the current remainder without advancing, and late or ambiguous state cannot
  advance credits. Reserve before
  processing, settle exactly once when a coherent item, price recommendation, and editable draft are
  durably available, and restore exactly once on failure/cancel before that point. A new item,
  changed photo set, or full re-analysis uses a new credit. Legacy daily limits are operational
  guardrails, not the native product promise. See ADR-0008.
- **Vercel AI SDK behind a role-keyed provider registry** (`src/lib/llm`, ADR-0002). All model
  calls resolve through `resolveLanguageModel(role, …)`; the provider is a `LLM_PROVIDER` flip
  (dev → Gemini for the free tier, showcase → OpenAI) — never construct a provider inline at a call
  site. Structured output via `generateObject` + **Zod** — no ad-hoc JSON parsing of model output.
  Embeddings are excluded from the switch (pgvector `vector(1536)` dimension lock).
- **Pricing is a routing pipeline behind a `PricingProvider` interface** (ISBN lookup → **eBay
  sold comps** → web-search agent → depreciation → LLM fallback; see `docs/adr/0001`). Caffein Apify
  is the default-off leading automatic sold-comp candidate, followed by the public-page provider;
  both must use the provider-neutral matcher. Every result is
  `{ suggested, range, confidence, sources[] }` and is user-editable. Never collapse this to a single
  source. The eBay-sold scraper is **read-only price research** — distinct from the transactional eBay
  **adapter**, which remains the only path for posting/messaging. Sold prices are **live-fetched**
  (cache-on-miss + age-decay, #59); the pgvector corpus does not contribute to pricing or confidence.
  Sold-comps egress
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
- **eBay marketplace mutations and messaging only ever go through adapter interfaces.** The one
  non-transactional exception is read-only public sold-page research through `ebay-sold`; it cannot
  post or message. SnapList owns unpublished drafts; after publish, eBay is authoritative for listing
  and order truth. External changes sync in, seller-confirmed changes go through the adapter, and
  only confirmed provider results become local truth. Conflicts are explicit, never silent
  last-write-wins. Keep every path testable offline against mock adapters, and leave production
  activation owner-controlled under #17 and ADR-0008.
- **Launch has no autonomous marketplace actions.** Publish, reprice, end, relist, add tracking/mark
  shipped, and send-message actions all require explicit seller confirmation. Buyer-Q&A may draft and
  ground a reply but cannot authorize delivery. Persist intent, outcome, grounding, provider result,
  and canonical delivery truth so retries never create a second external action.
- **Post-sale writes are allowlisted.** Standard Fulfillment may read orders/payment/fulfillment and
  ship-by data; `createShippingFulfillment` may add tracking/mark shipped after explicit confirmation.
  Inventory `withdrawOffer` may end a SnapList-managed listing sold elsewhere; a Trading end call is
  allowed only for a verified owned/mapped non-Inventory listing. Fulfillment `FULFILLED` means
  shipped, not carrier-delivered. Cancellations, refunds, returns/cases, disputes, and label purchase
  remain status/deep-link surfaces at launch.
- **Unsupported launch marketplaces use honest assisted handoffs.** Mercari, Facebook Marketplace,
  and Depop may receive platform-appropriate text/photos, the native share sheet or an honest deep
  link, and a completion checklist. Never claim SnapList filled or published the destination form.
  A sold-elsewhere record defaults **Also end on eBay** on but still requires one explicit confirm.
- **Profit requires cost basis.** Cost is optional on the draft and may be requested again at sale.
  Without it, show revenue, estimated fees, and estimated net proceeds—never profit. Adding cost later
  may update profit retroactively.
- **Log every pipeline run's predictions** (attributes, price, range, confidence, tier, model) from
  day one — the eval harness depends on it.
- **Listing-example retrieval is optional and evaluation-gated.** The validated item core is the
  factual authority. RAG is default-off, must fail open to no examples, never affects pricing or
  confidence, and cannot become a native client state or AI-item accounting boundary. Do not write
  seller drafts to the global corpus. See ADR-0010.
- **Review correction stays coherent and pre-publish.** Bounded identity edits must rerun the shared
  pricing router, composite confidence, and grounded listing generator, then atomically persist the
  item, eBay draft, and prediction log under RLS. Preserve seller price overrides, invalidate stale
  export packs, reject stale or authoritative publishing/published state, and never auto-publish.
- **Durable pipeline execution uses Supabase Queues, not a second pipeline.** `pipeline_runs` is the
  tenant-owned status/stage/attempt truth; the logged Basic Queue carries only `{ run_id,
  schema_version }`. Queue claim/ack authority is a narrow internal capability, never a generic
  service-role domain client. Worker domain access must derive ownership from the stored run through
  RLS or audited run-scoped RPCs. See ADR-0007.

## How we build
- **Matt workflow gates are explicit, not implied by setup.** Apply `to-tickets`
  once when an approved spec or parent is decomposed into child issues; do not
  rerun it on an existing child. Before that child can move to Ready, complete
  the repository issue contract with one finite outcome, binary acceptance
  criteria, blockers, owned surfaces, exclusions, and named test seams. Only a
  user-approved issue contract or explicit user confirmation approves the TDD
  seam. Implement changed behavior with `tdd`, one public-interface RED to
  minimal GREEN at a time. Use `diagnosing-bugs` before changing code for a
  regression whose cause is not proved. Before merge review, use `code-review`
  with separate fresh-context, read-only Standards and Spec reviewers; the code
  author cannot approve either axis. Every PR handoff names the applicable gates
  and evidence.
- **One issue, one branch, one isolated worktree, one PR.** Collision-check open
  issues, branches, worktrees, and PR diffs before implementation. If discovered
  work is not required by the frozen issue contract, split or route it instead
  of widening the branch.
- **Tracer-bullet + TDD.** Thin end-to-end threads: one or two backend pieces + minimal frontend to
  exercise them + tests, proven working before the next. No full-backend-then-frontend; no
  layer-by-layer. Always keep something that runs. A tracer bullet proves one finite observable
  behavior; it is not permission to build the complete surrounding system. It may cross layers only
  as far as that behavior requires. SnapList may split an independently observable,
  provider-neutral backend or native public seam from its consumer when that seam is contract-tested
  and explicitly blocks the consumer.
- **Bounded issue and review scope.** Freeze acceptance behavior, owned surfaces, non-goals, and
  proportional gates before implementation. More than two major production surfaces or roughly 15
  production files / 800 non-generated production lines is a mandatory re-scope checkpoint. Keep one
  slice only when the hub records why splitting would make correctness or delivery worse. Once review
  begins, do not add product or architecture scope. One review round is the combined assessment of one
  exact head by fresh Standards and Spec reviewers plus GitHub Codex. Count the first candidate as
  round 1/3 and request another round only after qualifying fixes change the head. P0/P1 block. P2
  blocks only for a proved in-scope acceptance, security/tenancy, data, external-side-effect or direct
  cost, unrecoverable-reliability, or required-test-validity defect. P3, cleanup, optional hardening,
  cosmetics, and adjacent discoveries become follow-up issues. After round 3, stop for split,
  redesign, or explicit owner direction.
- **Adjudicate GitHub Codex findings.** Treat the App as independent evidence, not authority. Apply
  the frozen issue contract, severity filter, scope split, and shared three-round counter. Run the
  fresh local Standards and Spec reviews first. Fix qualifying local blockers and obtain the required
  delta-focused local acceptance before requesting GitHub Codex on the resulting locally approved
  exact head. Route every valid adjacent or non-blocking finding to a focused existing or new issue,
  and explain invalid or out-of-scope findings with evidence. Do not chase a zero-comment review.
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
shadcn/ui · Vercel marketing deploy · $0 local Supabase + local Node API/worker is the development
target, with an explicitly limited Supabase Free + optional Render Free API + supervised local worker
path for remote pre-revenue validation after the owning API/auth issues land · Railway selected only
as the deferred paid API/worker target under #196 after an ADR-0009 upgrade trigger and owner approval
· eBay Sell + Trading APIs (sandbox → production, via adapter). Issue #195 proves the runtime and
durable-consume seams, not the #159-owned enqueue/RLS API, and performs no hosting, billing, or
provider migration. The native launch client is SwiftUI with StoreKit subscription state and App
Attest-backed guest abuse resistance; native implementation remains issue-owned and is not authorized
by documentation work.

## Conventions
- Confirm current OpenAI model IDs against live docs before hardcoding — they move fast.
- **Apple capability first in the native app.** Before adding a third-party or custom device-level
  capture or perception implementation, evaluate the supported Apple framework and use it when it
  supplies the needed primitive. Availability-gate hardware-specific capabilities and define an
  honest fallback. Device evidence is not external catalog, marketplace, pricing, or verified-
  condition truth; those remain behind provider-neutral server contracts. The issue and PR must name
  the Apple primitive checked, availability gate, fallback, and server-truth boundary.
- Secrets via env; never commit keys. Transactional eBay calls use per-user **encrypted** OAuth
  tokens; the app-level Sandbox fallback is restricted to one configured operator tenant/seller.
- For non-trivial UI work, follow the current provider-neutral Claude Design handoff and the user's
  global design workflow. Do not substitute a retired generator or begin SwiftUI implementation
  before the high-fidelity direction and owning issue are approved.
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

Issues and PRDs live as GitHub issues in `azizu06/snaplist` (prefer `gh-axi`; use
`gh` only for a documented wrapper gap). See `docs/agents/issue-tracker.md`.

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
- Before moving a slice to In review, record the frozen issue contract and `Review round: 0/3`.
  Compare the exact diff to the issue and remove or split anything unasked. Review never expands the
  issue contract.
