# Docs

Index of the `docs/` folder. Top-level project docs (`PRD.md`, `CONTEXT.md`,
`AGENTS.md`) live at the repo root; everything below is deeper reference material.

## Architecture Decision Records — [`adr/`](./adr)

- [0001 — eBay public sold-comps pricing](./adr/0001-ebay-public-sold-comps-pricing.md)
- [0002 — LLM provider registry (Gemini dev / OpenAI showcase)](./adr/0002-llm-provider-registry-gemini-dev-openai-showcase.md)
- [0003 — Sentry error tracking (DSN-gated)](./adr/0003-sentry-error-tracking-dsn-gated.md)
- [0004 — Abuse and cost protection](./adr/0004-abuse-and-cost-protection.md)
- [0005 — Billing: direct Stripe entitlement mirror](./adr/0005-billing-direct-stripe-entitlement-mirror.md)

## Engineering workflow — [`agents/`](./agents)

- [Domain glossary consumer rules](./agents/domain.md)
- [Issue tracker](./agents/issue-tracker.md)
- [Triage labels](./agents/triage-labels.md)

## Architecture — [`architecture/`](./architecture)

- [Scraper worker spec](./architecture/scraper-worker-spec.md) — extracting the eBay
  sold-comps scraper into a standalone worker.

## Marketplace integration

- [eBay production setup](./ebay-production.md)
- [eBay sandbox setup](./ebay-sandbox.md)
- [Sold-comps egress and operator smoke](./sold-comps-egress.md)

## Operations & planning

- [Billing plan](./billing-plan.md)
- [Security — OWASP audit (2026-06)](./security/owasp-audit-2026-06.md)
- [Product positioning](./strategy/positioning.md)
