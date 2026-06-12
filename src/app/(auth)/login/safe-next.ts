/**
 * Same-origin guard for a `next` redirect target. Shared by the login page (which
 * bounces an already-signed-in user) and the auth server actions, so BOTH paths
 * reject an absolute external URL like `?next=https://attacker.example` — Next's
 * `redirect()` would otherwise follow it (an open redirect).
 *
 * Only same-origin absolute paths (`/...`, but not protocol-relative `//...`) pass;
 * anything else falls back to `/upload`.
 */
export function safeNext(raw: unknown): string {
  const next = typeof raw === "string" ? raw : "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/upload";
}
