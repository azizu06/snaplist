import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixture = path.resolve(
  "src/test/fixtures/supabase-stack-unreachable.test.ts",
);
const vitestBin = path.resolve("node_modules/vitest/vitest.mjs");
const config = path.resolve("src/test/supabase-stack.fixture.config.ts");
const tempDirectories: string[] = [];

async function runFixture(requireStack: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "snaplist-vitest-"));
  tempDirectories.push(directory);
  const reportFile = path.join(directory, "report.json");

  try {
    await execFileAsync(
      process.execPath,
      [
        vitestBin,
        "run",
        fixture,
        "--config",
        config,
        "--reporter=json",
        "--outputFile",
        reportFile,
      ],
      {
        env: {
          ...process.env,
          SNAPLIST_REQUIRE_DB_STACK: requireStack ? "1" : "0",
          SUPABASE_ANON_KEY: "fixture-anon-key",
          SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key",
          SUPABASE_URL: "http://127.0.0.1:1",
        },
      },
    );
    return { exitCode: 0, report: JSON.parse(await readFile(reportFile, "utf8")) };
  } catch (error) {
    const report = await readFile(reportFile, "utf8").then(JSON.parse).catch(() => null);
    return {
      exitCode: (error as { code?: number }).code ?? 1,
      report,
    };
  }
}

async function listRootTests(testFile: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [vitestBin, "list", testFile],
  );
  return stdout;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("unreachable Supabase stack reporting", () => {
  it("keeps the dead-port fixture out of the root test collection", async () => {
    expect((await listRootTests(fixture)).trim()).toBe("");
  });

  it("reports guarded tests as skipped instead of passed", async () => {
    const result = await runFixture(false);

    expect(result.exitCode).toBe(0);
    expect(result.report.numPendingTests).toBeGreaterThan(0);
    expect(result.report.numPassedTests).toBe(0);
  });

  it("fails CI mode instead of accepting skipped tenancy coverage", async () => {
    const result = await runFixture(true);

    expect(result.exitCode).not.toBe(0);
  });
});
