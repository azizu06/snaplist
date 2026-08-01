# ADR-0002 — LLM provider registry: Gemini (dev) / OpenAI (showcase)

- **Status:** Accepted (2026-06-14)
- **Deciders:** Aziz
- **Implemented by:** issue #55
- **Relates to:** ADR-0001 (records the eBay-sold pricing tier; this ADR is the companion
  "models & LLM access" decision referenced there)

## Context

`AGENTS.md` mandates "OpenAI via the Vercel AI SDK … provider stays swappable," but in practice
every model call site constructed OpenAI inline (`createOpenAI()` + `openai.chat(id)`) with a local
`resolve<Role>Model()` and a `DEFAULT_<ROLE>_MODEL` — the same logic copy-pasted across ~9 files
(vision, listing, export, reply, judge, and the three pricing providers). "Swappable" was a hope,
not a checked property.

Two forces made this worth fixing now:

1. **Budget.** The OpenAI credit is ~$3.50. Building and testing against OpenAI burns it fast.
   Gemini has a generous free tier suitable for dev/build.
2. **Showcase fidelity.** The deployed showcase should still run on OpenAI (the strongest models,
   the interview narrative). So we need *both* providers, chosen by environment.

## Decision

1. **A role-keyed provider registry** at `src/lib/llm` (`resolveLanguageModel(role, …)`,
   `resolveModelId(role, …)`). Roles: `vision | listing | export | pricingAgent | judge | reply`.
   Every generation call site resolves its model through the registry — inline provider
   construction at a call site is now disallowed.

2. **Provider is a `LLM_PROVIDER` config flip.** It may be omitted **only on a local development
   machine**, where it means Gemini. Anywhere else an unset or misspelled value is a hard failure,
   not a default (amended 2026-07-25 by issue #501 — see "Amendment" below). `gemini` is accepted as
   an alias for `google`.

3. **Provider-aware, per-role model ids**, overridable by the existing `<ROLE>_MODEL` env vars (kept
   for back-compat). OpenAI defaults stay `gpt-5.5`; Gemini defaults to `gemini-2.5-flash`
   (multimodal — covers vision — and free-tier friendly). Confirm ids against live docs before
   changing (AGENTS.md).

4. **Keys via env only**, resolved per provider lazily at call time. `OPENAI_API_KEY` is now
   **optional**, with a schema guard requiring *at least one* of `OPENAI_API_KEY` /
   `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY` — so a Gemini-only dev env validates without an
   OpenAI key. Provider SDKs are lazy-imported, keeping the offline test path SDK-free.

5. **Embeddings are EXCLUDED from the provider switch.** The pgvector column is `vector(1536)` and
   OpenAI `text-embedding-3-small` is 1536-dim, while Gemini's embedding model differs in
   dimensionality — flipping the embedder would silently break cosine similarity against the seeded
   corpus. `rag/embedding.ts` keeps its OpenAI/synthetic seam; a Gemini-embeddings switch is a
   separate decision requiring a dimension-matched re-seed.

6. **A fixture + cross-provider contract layer.** Recorded provider responses (`fixtures/<role>.<provider>.json`)
   are replayed offline (`replayFixture`), and a contract test asserts that a response from **both**
   providers validates against each role's Zod output schema (`contracts.ts`). This turns "provider
   stays swappable" into a checked claim: if a provider's structured output drifts from a role's
   shape, the test fails before it reaches the showcase.

## Amendment 1 (2026-07-25, issue #501) — the free tier's data terms

The original decision recorded Gemini's free tier as a **cost** benefit only. It is also a **data**
decision, and the two must be stated together.

Google's Gemini API Terms (effective 2026-03-23) split on billing, not on environment. Under
**Unpaid Services** Google uses submitted content and responses "to improve, and develop Google
products and services", and "Human reviewers may read, annotate, and process your API input and
output." Under **Paid Services** it does not. The retention controls (7/14/28/55 days) are
[billing-gated](https://ai.google.dev/gemini-api/docs/logs-policy). The Google project in use is
confirmed **free tier, no billing configured** (owner, 2026-07-25).

That is an acceptable trade for a developer's own test items, and it remains the right call for
local development: it protects the ~$3.50 OpenAI credit and the data spent is the developer's own.
It is not acceptable for seller photos, which are taken inside people's homes and carry faces,
addresses, documents, and surroundings well beyond the item.

**The defect was not the exposure, it was the absence of a floor under it.** `resolveProvider` read
an unset `LLM_PROVIDER` identically in dev and in production, so the only thing keeping a deploy off
the free tier was remembering to set one variable, and nothing failed, warned, or logged if a deploy
omitted it.

### Amended posture

- An unset `LLM_PROVIDER` resolves **only** on a local development machine, and there it selects
  Gemini **by name** (`LOCAL_DEVELOPMENT_PROVIDER`) rather than by falling through a NODE_ENV branch
  a deploy shares.
- Anywhere else, an unset value throws from `resolveProvider`, fails `parseEnv` at config startup,
  and rejects from `instrumentation.register()`. So does a misspelled one, which is a set value the
  "unset" check would otherwise miss.
- **What the startup failure actually looks like.** Next.js does not exit on a rejected `register()`.
  It logs `Ready`, binds the port, fails `prepare()`, and then answers **every** route with a 500 for
  the life of the process — marketing pages and `/api/health` included, because the failure is at
  `prepare()` rather than at the model call. Verified against `next start` on this change. The
  deploy is unusable and fails closed, but it is not a crash loop and will not trip a platform
  health gate that only checks whether the port is bound. `resolveProvider` throwing at request time
  is the guarantee that holds identically on every platform; on Vercel's per-function path the
  `register()` rejection surfaces as an unhandled rejection rather than a clean startup failure.
  Sentry is initialized before the check so the config error reaches alerting rather than only the
  platform's raw logs.
- The check is deliberately absent from `next build`: `register()` is not invoked there (Next returns
  early during `phase-production-build`), preserving CI's "the production build must succeed without
  secrets" property. A build serves no seller, so the earliest point worth failing is startup.
- `LLM_PROVIDER`'s accepted vocabulary, casing, and whitespace rules live in one function,
  `llmProviderConfigError`. The env schema deliberately types it as a plain string rather than
  repeating a `z.enum`, which previously disagreed with the registry on values like `GEMINI`.
- **Local development** requires *both*: `NODE_ENV` absent or `development`/`test` (so `staging`,
  `preview`, and `production` all fail), **and** no hosted-platform runtime marker present
  (`VERCEL`, `VERCEL_ENV`, `RENDER`, `RAILWAY_ENVIRONMENT`, `FLY_APP_NAME`,
  `AWS_LAMBDA_FUNCTION_NAME`, `AWS_EXECUTION_ENV`, `KUBERNETES_SERVICE_HOST`, `NETLIFY`,
  `DYNO`). Every deploy target this
  project names sets one of them, and `next build` / `next start` set `NODE_ENV=production` on their
  own. `CI` is deliberately excluded: CI is not a deploy and gating on it would make the offline
  suite behave differently in CI than on the machine that wrote it.
- Key-awareness (a single-key box selects the provider it can actually run, #55) survives, but only
  behind the fence. An API key is a credential, never a provider choice: a production env holding
  only a Gemini key used to resolve to Google, and now fails.

### Known limit

A host that sets neither `NODE_ENV` nor any recognized platform marker would still read as local. No
target this project uses behaves that way, and adopting one is an ADR-0009 hosting decision that
should extend `DEPLOYMENT_MARKERS` at the same time.

### Condition this rests on

The local Gemini default is sound because the photos going through a developer's machine are that
developer's own. It stops holding the moment a photo they did not take enters the local pipeline —
foreseeably via a sourced (rather than self-shot) gold set, a seeded corpus carrying real listing
photos, or a TestFlight/friend-testing build pointed at a dev configuration. Revisit the local
default if any of those land.

### Migration required before this ships

Set `LLM_PROVIDER` in every deploy environment. This is a configuration step; the code cannot
perform it and deliberately will not guess.

The consequence of omitting it **depends on the host**, and the difference is worth recording
because it is easy to overstate:

- **Self-hosted, Docker, or any `next start`:** total outage. `register()` rejects, `prepare()`
  fails, and every route returns 500 for the life of the process. Verified directly.
- **Vercel:** no route-level regression observed. Vercel invokes `ensureInstrumentationRegistered`
  without awaiting it, so a rejected `register()` surfaces as an unhandled rejection rather than
  failing request handling. A preview deployment carrying this change served `/`, `/pricing`,
  `/login`, `/signup`, and `/api/health` identically to a deployment without it. On this host the
  protection therefore comes from `resolveProvider` throwing when a model is resolved, which is the
  platform-independent guarantee, not from the startup check.

So the startup check is a genuine hard stop only where the runtime awaits it. Do not rely on it as
the sole fence, and do not describe it as one.

## Amendment 2 (2026-08-01, issue #501) — the seller-media fence

Amendment 1 built a floor under the provider being reached by **omission**. It does not stop the
provider being reached by **choice**, which is the likelier mistake. Gemini was selected for its free
tier in the first place, and `AGENTS.md` said so; "save money, set `LLM_PROVIDER=gemini` in
production" is a reasonable-sounding decision that routed every seller photo into the unpaid bargain
with nothing objecting. Setting the variable was treated as sufficient, when *which value* it is set
to is the part that matters for seller data.

### Billing status of the Gemini project

**Free tier, no billing configured.** Recorded by the owner on 2026-07-25 (Amendment 1) and
unchanged as of 2026-08-01. Billing lives in the Google console and is not observable from this
repository, so this line is the single named slot for it: **if the owner enables billing on the
project, update this paragraph and this paragraph only** — no code changes, because the code asks
for the fact by name rather than inferring it. Note that enabling billing does not retroactively
cover content already submitted under the unpaid terms.

### Where real seller media can actually reach a Gemini key

Established by tracing the one path that carries media, not by inspecting configuration alone:

| Environment | Can real seller media reach a Gemini key? |
| --- | --- |
| Offline test suite (vitest) | **No.** `vision/extract.ts:202` takes `input.generate` by injection, so tests supply a fake and the registry is never reached. Recorded provider responses replay through `replayFixture`. Fixtures only. |
| Local development (`next dev`, worker, bare script) | **Yes**, and permitted. `LLM_PROVIDER` may be unset and means Gemini. The photos are the developer's own — the condition below. |
| Any deploy (`next start`, Docker, Vercel, Render) | **Yes**, and this is what the fence closes. `LLM_PROVIDER=gemini` was accepted with no further question. |

The media path itself: the durable pipeline worker composes vision stages
(`pipeline-queue/composition.ts:42`) → `vision/extract.ts:202` falls back to `createOpenAIVisionGenerate()`
→ `vision/extract.ts:331` resolves the model → `vision/extract.ts:336` attaches `{ type: "image" }`
parts whose bytes were downloaded from the private `photos` bucket (`vision/photos.ts:183`). `vision`
is the only role that sends media; every other role receives text derived from the item.

**Audio never reaches this registry at all.** `llm/seller-context.ts` carries its own
`sellerContext` transcription role, which is not one of `LLM_ROLES`, and
`resolveSellerContextTranscriber` returns `unsupported` with no model injected — no transcription
provider is wired. Transcription provider selection is decided separately (OpenAI
`/v1/audio/transcriptions`) and is out of scope here.

### Amended posture

- `SELLER_MEDIA_ROLES` names the roles that carry the seller's own media. It contains `vision`.
- Outside local development, resolving a seller-media role to Google **throws** unless
  `GEMINI_BILLING_ENABLED=true`. It is checked against the **effective** provider, so a call site
  that forces `provider: "google"` (the cross-family judge, a spike script) is fenced on the same
  terms as a deploy that selected it.
- The same condition fails `parseEnv` at config startup and rejects from `instrumentation.register()`.
  A deploy configured this way could not process a single item, so it should say so at boot rather
  than on the first seller's photo. As in Amendment 1, how hard the startup check stops depends on
  the host; `resolveLanguageModel` throwing is the guarantee that holds everywhere.
- `GEMINI_BILLING_ENABLED` accepts exactly `true` or `false` (any casing, trimmed) or nothing. Any
  other value is a config error rather than a silent `false`, whatever the active provider is — an
  attestation that looks set and acts unset is worse than one that is absent, and a stray `yes` on an
  OpenAI deploy must not become a surprise the day someone flips `LLM_PROVIDER`.
- Local development is still allowed, **by name**, on the condition recorded below. An attestation is
  not required there because requiring one would teach developers to set it untruthfully to make
  their box work, and that lie would then travel to a deploy. The variable is only ever needed where
  it means something, which is what keeps it meaningful.
- Nothing here weakens Amendment 1. An unset `LLM_PROVIDER` still fails outside local development.

### What this does not claim

The fence keys on the role, not on the bytes. It is therefore only as true as `SELLER_MEDIA_ROLES`
is, and a role that quietly gained a media payload would slip past it invisibly. That is why
`llm/seller-media-fence.test.ts` scans the source: every module building a media message part must be
a known seller-media module resolving a covered role, so a new media call site fails the suite until
someone decides deliberately what the fence should do about it.

It also does not verify the attestation. `GEMINI_BILLING_ENABLED=true` is an operator's claim about
an external fact, and a false claim buys exactly the exposure this fence exists to prevent. The error
text says so.

### Condition this rests on (restated, now load-bearing twice)

The local Gemini allowance is sound only while the photos crossing a developer's machine are that
developer's own. It stops holding the moment a photo they did not take enters the local pipeline —
foreseeably via a sourced (rather than self-shot) gold set, a seeded corpus carrying real listing
photos, or a TestFlight/friend-testing build pointed at a dev configuration. Amendment 1 already said
to revisit the local default if any of those land; the media fence now rests on the same condition,
so revisiting it means revisiting both.

The "Known limit" above compounds here: a host that sets neither `NODE_ENV` nor a recognized platform
marker reads as local, and would therefore bypass the media fence as well as the provider fence.
Extending `DEPLOYMENT_MARKERS` when adopting such a host is now two guards' concern, not one.

### Migration required before this ships

Any deploy currently running `LLM_PROVIDER=gemini` must either move to `LLM_PROVIDER=openai` or
enable billing on the Google project and set `GEMINI_BILLING_ENABLED=true`. As with Amendment 1 this
is a configuration step; the code will not guess it.

### Still outstanding

Nothing from Amendment 1. `AGENTS.md:41` — which described Gemini as the dev default "for the free
tier" without its data terms, and misdescribed behavior once the production default was removed — was
amended by this change and now states the required-in-every-deploy rule and the seller-media fence
alongside the cost benefit.

## Alternatives considered

- **Stay OpenAI-only, just be frugal** — rejected: burns the budget during routine dev, and leaves
  "swappable" unproven (a portfolio claim worth actually demonstrating).
- **Vercel AI Gateway / `"provider/model"` strings** — viable, but a thin local registry keeps the
  swap logic explicit and inspectable (the engineering being showcased), with no gateway dependency.
- **Switch embeddings too** — rejected for now (dimension lock; see decision 5).
- **Rename every `createOpenAI<Role>` factory to a provider-neutral name** — deferred: correct but a
  wide rename rippling through exports/tests; the names are now documented as registry-routed, and a
  rename is a low-risk follow-up.

## Consequences

- **Positive:** dev/build runs free on Gemini while the showcase keeps OpenAI; adding a provider is
  one registry map entry, not 9 edits; "swappable" is contract-tested across providers; the offline
  test path is unchanged (DI fakes still bypass the registry).
- **Negative / risks:** model ids drift (mitigated: env-overridable + a documented confirm step);
  the checked-in fixtures are realistic stand-ins until regenerated against live APIs (the contract
  test still guarantees schema-validity); embeddings remain single-provider until a re-seed.
- **Honesty for the README/interview:** "provider-swappable" is demonstrable (run the suite on
  either provider) rather than asserted.

## Docs touched

`AGENTS.md` (the LLM non-negotiable + Stack), `PRD.md` (Models & LLM access), `.env.example`
(provider keys + `LLM_PROVIDER`).
