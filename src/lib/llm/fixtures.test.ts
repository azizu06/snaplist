import { describe, expect, it } from "vitest";
import { LLM_PROVIDERS } from "./registry";
import { MODEL_FACING_SCHEMAS, fixtureSchemaForRole } from "./contracts";
import { loadLlmFixture, replayFixture } from "./fixtures";

/**
 * Cross-provider contract test (issue #55). For every role that has recorded
 * fixtures, a response from BOTH providers must validate against that role's Zod
 * contract — the check that makes "provider stays swappable" real. Runs fully
 * offline by replaying the checked-in fixtures.
 */

/** Roles with recorded fixtures (the issue's named roles). Export routes */
/** through the same registry and are covered by their own module tests. */
const FIXTURE_ROLES = ["vision", "listing", "pricingAgent", "judge"] as const;

describe("LLM cross-provider response contracts", () => {
  for (const role of FIXTURE_ROLES) {
    for (const provider of LLM_PROVIDERS) {
      it(`${role} × ${provider}: recorded response satisfies the role's Zod contract`, () => {
        const fixture = loadLlmFixture(role, provider);
        const schema = fixtureSchemaForRole(role);
        expect(schema, `no fixture-bearing schema registered for role ${role}`).toBeDefined();
        const result = schema!.safeParse(fixture);
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

  it("resolves each fixture role to exactly ONE registered call site", () => {
    // `pricingAgent` and `vision` each drive several `generateObject` call sites,
    // but a role has ONE recorded fixture pair. Marking a second call site as the
    // fixture schema would make `fixtureSchemaForRole` return whichever came
    // first in the registry — a silent swap of what these fixtures actually pin.
    for (const role of FIXTURE_ROLES) {
      const marked = MODEL_FACING_SCHEMAS.filter((e) => e.role === role && e.fixture);
      expect(marked.length, `role ${role} has ${marked.length} fixture-marked schemas`).toBe(1);
    }
  });
});

describe("replayFixture", () => {
  it("returns the recorded object as an injectable async fake (no network)", async () => {
    const fixture = loadLlmFixture("judge", "openai");
    const generate = replayFixture(fixture);
    await expect(generate()).resolves.toEqual(fixture);
  });
});
