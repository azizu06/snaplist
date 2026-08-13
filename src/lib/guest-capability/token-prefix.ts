/**
 * Issue #810. The prefix that marks a bearer token as a verified-guest
 * capability rather than a Clerk session token. Minted once in
 * `service.ts` and read here by every consumer so a future prefix change
 * cannot silently strand a caller on a hand-written literal.
 */
export const GUEST_CAPABILITY_TOKEN_PREFIX = "guestcap_";

/**
 * Issue #816. The one place the bearer shape is spelled on this side of the
 * wire. The prefix is escaped rather than spliced raw so a future prefix
 * carrying a regex metacharacter — `guesthandoff_v1.` is a sibling that
 * already does — is matched as text and cannot widen what this validator
 * accepts. `AppAttestClient.swift` escapes the same way for the same reason.
 */
export function guestCapabilityBearerTokenPattern(prefix: string): RegExp {
  const literalPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literalPrefix}[A-Za-z0-9_-]{43}$`);
}
