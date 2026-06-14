# ADR-0003: Sentry error tracking, DSN-gated, layered on structured logging

Status: accepted · Issue #62

## Context

Structured logging already exists (`src/lib/observability.ts`, #18): one JSON line per event to
stdout, where every deploy target collects logs. That serves *local* debugging well, but for a
deployed app it lacks stack traces, grouping ("this error fired 47× since the deploy"), request
context, and alerting. The PRD lists observability (Sentry) as a production-real skill surface.

Constraints: build offline (no live keys at build time); the app is Next 16 + Turbopack; and a
`node:`-deps package must never reach a client bundle (a prior #55 build break taught this).

## Decision

Add Sentry as an **optional, DSN-gated error sink layered on the existing structured logger**, not a
replacement for it.

- **`@sentry/node`, server-side only.** Initialized once at server boot from `instrumentation.ts`
  `register()`; `onRequestError` captures unhandled request/render errors. We deliberately do NOT use
  `@sentry/nextjs` + `withSentryConfig` yet: its build wrapping adds Turbopack/Next-16 surface we
  can't verify against a live Sentry while building offline. Client-side capture is a clean follow-up
  that layers on top without rework.
- **DSN-gated.** No `SENTRY_DSN` → fully inert (no init, no network, no account needed). Dev and the
  offline test suite never touch it. It activates the moment a DSN is set in the deploy env.
- **Loaded only via dynamic `import("@sentry/node")` inside `initSentry`.** Never a static import, so
  it can never land in a client bundle. `captureError` is synchronous and uses the module cached at
  init — a no-op until configured.
- **One server-error chokepoint: `reportServerError(context, err, fields)`** (`src/lib/sentry.ts`) =
  a structured `ok:false` log line **and** a Sentry capture. Wired into `logServerError` (API routes)
  and every server-action / server-component catch that handles an internal failure, so the AI
  pipeline's failures (the product) are both greppable and grouped/alerted — while the client still
  only ever sees a generic, redacted message (CWE-209, #57).
- **Field discipline** (inherited from #18): identifiers and signals only — never photo contents,
  listing copy, tokens, headers, or anything a user typed. `tracesSampleRate: 0` (errors only; perf
  tracing is a separate, costlier opt-in).

## Consequences

- Error tracking is free and zero-risk until a DSN exists; turning it on is a one-line env change.
- Client-side (browser) errors are not yet captured — tracked as a follow-up if/when wanted.
- Source-map symbolication (via `withSentryConfig` upload) is deferred with the `@sentry/nextjs` move.
