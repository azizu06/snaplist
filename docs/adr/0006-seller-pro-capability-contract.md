# ADR-0006 — Seller Pro is a server-enforced capacity contract

- **Status:** Accepted (2026-07-14)
- **Deciders:** Aziz
- **Implemented by:** issue #153

## Context

ADR-0005 established a secure Stripe-to-Supabase entitlement mirror, but the
product had three competing interpretations of Seller Pro: Settings and the
daily quota used the mirror, rate-limit hot paths defaulted to Free, and
marketing advertised bulk capture, priority research, analytics, and support
without matching server behavior. The PRD already defines bulk / haul capture
as a first-class reseller workflow.

## Decision

1. **Seller Pro is capacity-only until a new capability has real server behavior.**

   | Contract row | Free | Seller Pro |
   | --- | --- | --- |
   | Photo-to-listing pipeline | Included | Included |
   | Bulk / haul capture | Included | Included |
   | eBay publish and cross-list export packs | Included | Included |
   | Buyer-Q&A drafts and inbox | Included | Included |
   | Processed items/day (default) | 15 | 200 |
   | Metered requests/minute (default) | 20 | 60 |

   The numeric limits remain environment-configurable. Priority research,
   model-quality changes, analytics, and priority support are not capabilities
   in this contract because SnapList has no server-gated implementation for
   them; they must not be advertised.

2. **Bulk / haul capture remains Free.** The batch page and `POST /api/batch/item`
   stay reachable to every authenticated seller. Each submitted item consumes
   the same trusted per-minute and daily capacity guards as single-item capture.

3. **`resolveSellerPolicy(userId)` is the one async server policy seam.** It
   reads the user-scoped, RLS-protected subscription mirror through
   `getEntitlement`, then returns the effective tier, `tierLimits`, and the
   explicit capability matrix. A missing, stale/canceled, failed, or
   cross-tenant read resolves to Free. Browser-supplied tier state is never an
   input.

4. **Every metered enforcement surface uses that policy.** `enforceRateLimit`
   (API routes) and `rateLimitAllows` (server actions) resolve it when a caller
   does not already have a request-scoped policy. The single upload action and
   batch-item route resolve once and pass the same policy to their per-minute
   and daily-item checks. Settings renders the same resolved policy; marketing
   imports the capability matrix and policy limits for its plan table.

## Consequences

- **Positive:** one truthful plan description across the PRD, marketing,
  Settings, routes, and server actions; paid sellers receive the capacity they
  purchase; a canceled or inaccessible mirror cannot over-entitle a seller.
- **Trade-off:** the rate limiter now does an entitlement-mirror read for a
  metered authenticated request unless a request seam passes an already-resolved
  policy. This is intentional correctness work; the mirror avoids a Stripe
  round-trip and trusted policy reuse avoids duplicate reads for pipeline runs.
- **Follow-up rule:** a future paid capability needs an explicit matrix row,
  real server implementation and gate, and policy/route/action tests before it
  can appear in Pricing or Settings.
