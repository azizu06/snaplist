/**
 * Same-origin guard for a `next` redirect target. Shared by the login page (which
 * bounces an already-signed-in user) and the auth server actions, so BOTH paths
 * reject an absolute external URL like `?next=https://attacker.example` — Next's
 * `redirect()` would otherwise follow it (an open redirect).
 *
 * Only same-origin absolute paths pass; anything else falls back to `/upload`.
 * Rejected: protocol-relative `//...` AND its backslash equivalence class
 * (`/\...`) — WHATWG URL parsing normalizes `\` to `/` in http(s), so a
 * Location of `/\evil.example` resolves cross-origin just like `//evil.example`.
 */
export function safeNext(raw: unknown): string {
  const next = typeof raw === "string" ? raw : "";
  return /^\/(?![/\\])/.test(next) ? next : "/upload";
}
