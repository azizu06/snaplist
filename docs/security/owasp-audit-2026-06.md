# SnapList — OWASP Security Audit (2026-06)

Issue #57. Audit across eight dimensions, each finding adversarially verified against the
codebase's actual protections (so RLS-/Zod-/Clerk-guarded paths are not reported as false
positives). Scope: `src/app/api/**` route handlers, `"use server"` actions, the LLM/pricing/inbox
libraries, and the outbound-fetch surfaces.

## Posture summary

The multi-tenant security model held up under audit. The verified result was **three findings**
(one LOW, two MEDIUM), all now fixed; the architecture's core controls are sound:

- **Tenant isolation (RLS).** Per-user data paths run on the RLS-enforced Supabase client (Clerk
  identity via `public.clerk_user_id()`); a foreign id is indistinguishable from a missing one (404).
  The audit found **one exception** — the few-shot corpus retrieval on the authenticated upload path
  preferred the `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS (F-2, fixed). The corpus is global
  anon-readable reference data, so no cross-tenant data leaked, but a service-role client must never
  run on a request path; it now uses the anon key. **Legitimate service-role uses** (verified
  appropriate): the server-side cross-tenant eval script, and the eBay account-deletion webhook
  (`POST /api/ebay/account-deletion`) which calls `createAdminClient()` only *after* verifying eBay's
  signature — a non-Clerk, signature-authenticated webhook that must erase a user's data across
  tables, so the admin client is the correct credential there.
- **AuthN/AuthZ.** The user-facing API routes and server actions gate on Clerk (`getUserId` → 401)
  before any side effect; ownership is proven through RLS rather than client-supplied ids (no IDOR
  found). The single non-Clerk route is the eBay account-deletion webhook, which authenticates by
  verifying eBay's signed challenge/notification instead (the correct model for a third-party webhook).
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
conflict errors, the account-deletion server-side `logEvent`, and the `parseReviewEdits` validation
messages — were left intact (no raw internals).

### F-2 (MEDIUM) — Service-role client on a per-user request path (RLS bypass)

`createRealFewShotRetrieval` (`src/lib/listing/generate.ts`) — invoked from the authenticated upload
pipeline — built its Supabase client preferring `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses RLS**.
The data read is the *global, anon-readable* reference corpus (SELECT policies for both `anon` and
`authenticated`; no write policy; RPC is `SECURITY INVOKER`), so no tenant data was exposed — but a
service-role client must never be reachable from a request path (a latent footgun the moment that
client touches a tenant-scoped table). **Fix.** Extracted `corpusReadKey()` which returns the **anon**
key only (never the service role) and unit-tested that property; the request-path read is now
RLS-respecting. (My initial audit wrongly claimed no service-role client was request-reachable —
Codex review on #71 caught it.)

### F-3 (LOW, CWE-209) — Server actions redirected raw errors WITHOUT logging

The `uploadAndProcess` (storage + pipeline), `saveReview` (Supabase), `publishToEbay`, and
`disconnectEbay` server actions put raw `err.message` into the `?error=` redirect query string and
did **not** log it server-side — strictly worse than F-1 (the detail reached the client and nowhere
else). **Fix.** Each now records the real error with `logEvent(...)` and redirects a generic message.
(OAuth `connect`/`callback` already `logEvent` and surface user-actionable OAuth-flow feedback — left
as-is.)

## Not changed (by design)

OAuth `connect`/`callback` redirects surface user-actionable OAuth-flow feedback and already log
server-side — left for UX. Live `s-card` markup handling for the scraper is tracked to #59;
pricing-precision tuning to #61.
