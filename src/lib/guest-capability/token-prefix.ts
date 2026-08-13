/**
 * Issue #810. The prefix that marks a bearer token as a verified-guest
 * capability rather than a Clerk session token. Minted once in
 * `service.ts` and read here by every consumer so a future prefix change
 * cannot silently strand a caller on a hand-written literal.
 */
export const GUEST_CAPABILITY_TOKEN_PREFIX = "guestcap_";
