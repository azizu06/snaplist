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

2. **Provider is a `LLM_PROVIDER` config flip**, defaulting to **Gemini in dev and OpenAI in
   production** (so "Gemini dev / OpenAI showcase" needs zero config locally, and a showcase/preview
   deploy just sets `LLM_PROVIDER=openai`). `gemini` is accepted as an alias for `google`.

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
