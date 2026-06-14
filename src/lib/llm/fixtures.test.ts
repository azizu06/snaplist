import { describe, expect, it } from "vitest";
import { LLM_PROVIDERS } from "./registry";
import { ROLE_OUTPUT_SCHEMA } from "./contracts";
import { loadLlmFixture, replayFixture } from "./fixtures";

/**
 * Cross-provider contract test (issue #55). For every role that has recorded
 * fixtures, a response from BOTH providers must validate against that role's Zod
 * contract — the check that makes "provider stays swappable" real. Runs fully
 * offline by replaying the checked-in fixtures.
 */

/** Roles with recorded fixtures (the issue's named roles). export/reply route */
/** through the same registry and are covered by their own module tests. */
const FIXTURE_ROLES = ["vision", "listing", "pricingAgent", "judge"] as const;

describe("LLM cross-provider response contracts", () => {
  for (const role of FIXTURE_ROLES) {
    for (const provider of LLM_PROVIDERS) {
      it(`${role} × ${provider}: recorded response satisfies the role's Zod contract`, () => {
        const fixture = loadLlmFixture(role, provider);
        const result = ROLE_OUTPUT_SCHEMA[role].safeParse(fixture);
        // Surface the validation issues if it ever drifts, instead of a bare false.
        expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(
          true,
        );
      });
    }
  }

  it("covers both providers for every fixture role", () => {
    // Guard against silently dropping a provider from the matrix.
    expect(LLM_PROVIDERS).toEqual(["openai", "google"]);
    expect(FIXTURE_ROLES.length).toBeGreaterThanOrEqual(4);
  });
});

describe("replayFixture", () => {
  it("returns the recorded object as an injectable async fake (no network)", async () => {
    const fixture = loadLlmFixture("judge", "openai");
    const generate = replayFixture(fixture);
    await expect(generate()).resolves.toEqual(fixture);
  });
});
