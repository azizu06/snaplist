import { describe, expect, it } from "vitest";
import {
  GUEST_CAPABILITY_TOKEN_PREFIX,
  guestCapabilityBearerTokenPattern,
} from "./token-prefix";

const BODY = "A".repeat(43);

describe("guest capability bearer token pattern", () => {
  it("accepts a bearer minted under the shipped prefix", () => {
    const pattern = guestCapabilityBearerTokenPattern(GUEST_CAPABILITY_TOKEN_PREFIX);

    expect(pattern.test(`${GUEST_CAPABILITY_TOKEN_PREFIX}${BODY}`)).toBe(true);
  });

  // Issue #816. #810 made the prefix shared so an edit propagates to both
  // languages by itself. A prefix carrying a regex metacharacter would then
  // propagate as *pattern* rather than as text and quietly widen what counts
  // as a guest bearer — the sibling `guesthandoff_v1.` prefix shows that a
  // dotted prefix is a real shape in this repo.
  it("matches a prefix metacharacter literally rather than widening", () => {
    const pattern = guestCapabilityBearerTokenPattern("guestcap.v2_");

    expect(pattern.test(`guestcap.v2_${BODY}`)).toBe(true);
    expect(pattern.test(`guestcapXv2_${BODY}`)).toBe(false);
  });
});
