import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("required CI verification", () => {
  it("runs source checks before slower test, eval, and build gates", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const verifyJob = workflow.match(/\n  verify:\n([\s\S]*?)\n  database:/)?.[1];

    expect(verifyJob).toBeDefined();

    const commands = Array.from(
      verifyJob!.matchAll(/^\s+(?:-\s+)?run:\s+(pnpm .+)$/gm),
      ([, command]) => command,
    );

    expect(commands).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm audit:migrations",
      "pnpm test",
      "pnpm eval",
      "pnpm build",
    ]);
  });
});
