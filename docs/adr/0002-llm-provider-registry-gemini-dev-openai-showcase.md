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

## Amendment (2026-07-25, issue #501) — the free tier's data terms

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
  and refuses server boot from `instrumentation.register()`. So does a misspelled one, which is a
  set value the "unset" check would otherwise miss.
- The check is deliberately absent from `next build`: `register()` is not invoked there, preserving
  CI's "the production build must succeed without secrets" property. A build serves no seller, so
  the earliest point worth failing is boot.
- **Local development** requires *both*: `NODE_ENV` absent or `development`/`test` (so `staging`,
  `preview`, and `production` all fail), **and** no hosted-platform runtime marker present
  (`VERCEL`, `RENDER`, `RAILWAY_ENVIRONMENT`, `FLY_APP_NAME`, `AWS_LAMBDA_FUNCTION_NAME`,
  `AWS_EXECUTION_ENV`, `KUBERNETES_SERVICE_HOST`, `NETLIFY`, `DYNO`). Every deploy target this
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

The `AGENTS.md` non-negotiable still describes Gemini as the dev default "for the free tier" without
its data terms. That line is amended in a follow-up, to avoid colliding with PR #500, which is open
against that file.

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
