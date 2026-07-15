# Docs

Index of the `docs/` folder. Top-level project docs (`PRD.md`, `CONTEXT.md`,
`AGENTS.md`) live at the repo root; everything below is deeper reference material.

## Architecture Decision Records — [`adr/`](./adr)

- [0001 — eBay public sold-comps pricing](./adr/0001-ebay-public-sold-comps-pricing.md)
- [0002 — LLM provider registry (Gemini dev / OpenAI showcase)](./adr/0002-llm-provider-registry-gemini-dev-openai-showcase.md)
- [0003 — Sentry error tracking (DSN-gated)](./adr/0003-sentry-error-tracking-dsn-gated.md)
- [0004 — Abuse and cost protection](./adr/0004-abuse-and-cost-protection.md)
- [0005 — Billing: direct Stripe entitlement mirror](./adr/0005-billing-direct-stripe-entitlement-mirror.md)
- [0007 — Durable listing pipeline on Supabase Queues](./adr/0007-durable-pipeline-supabase-queues.md)

## Engineering workflow — [`agents/`](./agents)

- [Domain glossary consumer rules](./agents/domain.md)
- [Issue tracker](./agents/issue-tracker.md)
- [Triage labels](./agents/triage-labels.md)

## Architecture — [`architecture/`](./architecture)

- [Durable listing-pipeline architecture](./architecture/durable-pipeline.md) — logged Supabase
  Queue, run lifecycle, adapter, and worker identity boundary.
- [Superseded scraper worker spec](./architecture/scraper-worker-spec.md) — historical
  RabbitMQ/Go analysis retained for context; not the implementation plan.

## Marketplace integration

- [eBay production setup](./ebay-production.md)
- [eBay sandbox setup](./ebay-sandbox.md)
- [eBay pre-sale messaging Sandbox runbook](./ebay-messaging-sandbox.md)
- [Sold-comps egress and operator smoke](./sold-comps-egress.md)

## Operations & planning

- [Billing plan](./billing-plan.md)
- [Security — OWASP audit (2026-06)](./security/owasp-audit-2026-06.md)
- [Product positioning](./strategy/positioning.md)
