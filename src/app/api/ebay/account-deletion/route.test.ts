import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeChallengeResponse } from "./route";

/**
 * Contract test for the eBay Marketplace Account Deletion challenge-response.
 * eBay computes sha256(challengeCode + verificationToken + endpoint) and compares
 * the lowercase hex digest. This pins the concatenation ORDER and encoding, which
 * is the entire reason endpoints fail validation. Pure crypto — runs without Docker.
 */
describe("computeChallengeResponse (eBay account-deletion verification)", () => {
  const challengeCode = "abc123";
  const verificationToken = "snaplist-verification-token-0123456789";
  const endpoint = "https://snaplist.example.com/api/ebay/account-deletion";

  it("returns the SHA-256 hex digest of challengeCode + token + endpoint, in that order", () => {
    const expected = createHash("sha256")
      .update(challengeCode)
      .update(verificationToken)
      .update(endpoint)
      .digest("hex");

    expect(computeChallengeResponse(challengeCode, verificationToken, endpoint)).toBe(
      expected,
    );
  });

  it("produces a 64-char lowercase hex string (not base64)", () => {
    const out = computeChallengeResponse(challengeCode, verificationToken, endpoint);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-sensitive: swapping token and endpoint changes the hash", () => {
    const correct = computeChallengeResponse(
      challengeCode,
      verificationToken,
      endpoint,
    );
    const swapped = computeChallengeResponse(
      challengeCode,
      endpoint,
      verificationToken,
    );
    expect(correct).not.toBe(swapped);
  });

  it("changes when any single input changes", () => {
    const base = computeChallengeResponse(challengeCode, verificationToken, endpoint);
    expect(
      computeChallengeResponse("different", verificationToken, endpoint),
    ).not.toBe(base);
    expect(
      computeChallengeResponse(challengeCode, "different", endpoint),
    ).not.toBe(base);
    expect(
      computeChallengeResponse(challengeCode, verificationToken, "https://other"),
    ).not.toBe(base);
  });
});
