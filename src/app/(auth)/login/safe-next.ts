/**
 * Same-origin guard for a `next` redirect target. Shared by the login page (which
 * bounces an already-signed-in user) and the auth server actions, so BOTH paths
 * reject an absolute external URL like `?next=https://attacker.example` — Next's
 * `redirect()` would otherwise follow it (an open redirect).
 *
 * Validated by resolving against a fixed dummy origin with the WHATWG URL parser —
 * the same parser the browser applies to a Location header — and requiring the
 * resolved origin to stay put. A character regex can't do this safely: the parser
 * normalizes before matching (strips ASCII tab/LF/CR, treats `\` as `/` in http(s)),
 * so `//evil.example`, `/\evil.example`, and `/<tab>/evil.example` all resolve
 * cross-origin from strings that look like plain paths. Control characters are also
 * rejected in decoded form (`%09` etc.) as defense in depth for callers handing in
 * a still-encoded value. Anything that fails falls back to `/`.
 *
 * The fallback is the marketing home because #598 retired the web app route
 * group and the launch client is SwiftUI, so there is no signed-in web
 * destination to land on. Where the post-signup path should actually go is #191.
 */
const FALLBACK = "/";
const BASE_ORIGIN = "https://safe-next.invalid";

export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return FALLBACK;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return FALLBACK;
  }
  if (/[\u0000-\u001F\u007F]/.test(decoded)) return FALLBACK;

  let resolved: URL;
  try {
    resolved = new URL(raw, BASE_ORIGIN);
  } catch {
    return FALLBACK;
  }
  if (resolved.origin !== BASE_ORIGIN) return FALLBACK;

  return raw;
}
