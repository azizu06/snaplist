# SnapList — OWASP Security Audit (2026-06)

Issue #57. Audit across eight dimensions, each finding adversarially verified against the
codebase's actual protections (so RLS-/Zod-/Clerk-guarded paths are not reported as false
positives). Scope: `src/app/api/**` route handlers, `"use server"` actions, the LLM/pricing/inbox
libraries, and the outbound-fetch surfaces.

## Posture summary

The multi-tenant security model held up under audit. The verified result was **one LOW-severity
finding** (now fixed); the architecture's core controls are sound:

- **Tenant isolation (RLS).** Every per-user data path runs on the RLS-enforced Supabase client
  (Clerk identity via `public.clerk_user_id()`); a foreign id is indistinguishable from a missing
  one (404). No service-role client is reachable from a request path — the only service-role use is
  the server-side cross-tenant eval script, which is the honest credential for that job.
- **AuthN/AuthZ.** API routes and server actions gate on Clerk (`getUserId` → 401) before any side
  effect; ownership is proven through RLS rather than client-supplied ids (no IDOR found).
- **Input validation.** External inputs are Zod-validated at the trust boundary (route bodies,
  params, env). The eBay account-deletion webhook verifies eBay's SHA-256 challenge-response with the
  verification token before acting.
- **Injection.** No raw/interpolated SQL (typed Supabase query builder + RLS). Prompt inputs
  (attributes, scraped content, buyer messages) flow through structured `generateObject` calls.
- **XSS.** No `dangerouslySetInnerHTML` over user/LLM content; React auto-escaping covers the
  rendered surfaces.
- **File upload.** Photos are stored under `user_id`-scoped paths with type/size/count limits.
- **SSRF.** The eBay-sold scraper validates every URL (`assertSafeEbayUrl`: https-only, eBay-host
  allowlist, no internal/IP hosts, `redirect: "error"`) at the provider boundary — both the primary
  and the injectable fallback fetch seam (hardened in #56).
- **Secrets.** Server-only secrets stay out of the client bundle; only `NEXT_PUBLIC_*` reaches the
  browser; webhook/log error objects keep raw detail server-side.

## Finding & fix

### F-1 (LOW, CWE-209) — Verbose internal errors returned to API clients

`src/app/api/inbox/{[messageId]/send,[messageId]/retry-delivery,simulate}` returned raw
`err.message` in 500 responses, which can embed Supabase/Postgres strings (column/constraint names,
type-cast failures, RLS hints). Auth-gated and RLS-scoped, so no cross-tenant or secret leak — the
impact is verbose-error reconnaissance to an already-authenticated user. The same pattern existed in
`src/app/api/ebay/publish` (the confirmed finding's class).

**Fix.** A single chokepoint, `src/lib/api/errors.ts` (`logServerError` / `serverErrorJson`), logs
the real error server-side and returns a generic client message. Wired into the inbox routes and the
publish route; the not-found → 404 distinction is preserved with a clean message. (The structured-
logging / Sentry sink replaces `console.error` in #62.) Controlled application messages — 409
conflict errors, the account-deletion server-side `logEvent` — were left intact (no raw internals).

## Not changed (by design)

OAuth/connect/callback and server-action redirects surface their own error text to the *user's own*
flow (low sensitivity, user-actionable, server-logged) — left for UX. Live `s-card` markup handling
for the scraper is tracked to #59; pricing-precision tuning to #61.
