# ADR-0010: Evaluation-gated listing-example retrieval

- Status: Accepted
- Date: 2026-07-19
- Decision owners: SnapList product and engineering

## Context

The original web-era plan required a seeded pgvector corpus for two jobs. It was expected to
corroborate pricing and provide few-shot examples for listing generation. The implemented pricing
corroboration helper has no production caller. Listing generation and guided correction do call
retrieval, but retrieval currently runs before model generation and can fail the whole operation.

The native launch contract now has stronger seams. Current sold evidence belongs to the
provider-neutral pricing router. Validated item attributes are the only listing facts. The durable
pipeline must produce or recover a usable draft without depending on an embedding provider or vector
query. The realistic-synthetic corpus has not demonstrated a measurable reduction in seller work and
contains prose that is not suitable as factual production authority.

## Decision

Listing-example retrieval is an optional server-side adapter at the listing-generation seam. It is
default-off until a bounded paired evaluation proves user value.

Disabled, empty, incompatible, timed-out, or failed retrieval returns no examples. It cannot fail
identification, pricing, listing generation, guided correction, recovery, or AI-item accounting. The
native client has no retrieval-specific contract.

The reference corpus never contributes to suggested price, range, confidence, evidence, freshness,
or provider selection. Examples may influence style and structure only. Validated item attributes
remain the sole factual authority.

Seller-approved drafts are not written to the global readable corpus. A future learning or
personalization feature requires its own tenant-scoped privacy and consent decision.

The existing pgvector schema remains compatible during evaluation. If retrieval fails its evaluation,
a later contract migration may remove the unused runtime, data, and schema after proving that no other
consumer remains.

## Evaluation gate

Compare the same gold-set items with retrieval enabled and disabled. Define the pass threshold before
running the experiment. Measure seller edit burden or first-pass acceptance, unsupported-claim rate,
latency, and incremental cost. Retrieval may become an enabled product capability only when it shows a
meaningful seller benefit, does not increase unsupported claims, and stays within the approved latency
and cost bounds.

If the gate does not pass, remove runtime retrieval. Do not extend the experiment through repeated
prompt or corpus tuning without a new product decision.

## Consequences

- The pricing router and confidence composite become simpler and keep one evidence authority.
- A corpus or embedding outage cannot block first value or consume another AI-item credit.
- The mobile app does not expose RAG states or configuration.
- Existing runtime retrieval must be hardened in a separate tracer-bullet ticket.
- The current realistic-synthetic seed is retained only as disclosed evaluation material until the
  keep-or-remove decision.
- README and unit-economics claims must be reconciled with the actual runtime when the hardening ticket
  lands.
