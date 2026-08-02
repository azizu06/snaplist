import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldSkipGuestFirstRunForOfflineCi } from "./guest-first-run-test-mode";

describe("verified guest focused-selector execution mode", () => {
  it.each([
    [{}, false],
    [{ GITHUB_ACTIONS: "true" }, false],
    [{ SNAPLIST_OFFLINE_VERIFY: "1" }, false],
    [
      { GITHUB_ACTIONS: "true", SNAPLIST_OFFLINE_VERIFY: "1" },
      true,
    ],
    [
      { GITHUB_ACTIONS: "false", SNAPLIST_OFFLINE_VERIFY: "1" },
      false,
    ],
  ])("skips only the explicit GitHub offline verify context", (env, expected) => {
    expect(shouldSkipGuestFirstRunForOfflineCi(env)).toBe(expected);
  });

  it("marks only the offline CI test step", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(workflow).toMatch(
      /- name: Run the offline Vitest suite\s+env:\s+SNAPLIST_OFFLINE_VERIFY: "1"\s+SNAPLIST_REQUIRE_DB_STACK: "1"\s+run: pnpm test/i,
    );
  });
});
