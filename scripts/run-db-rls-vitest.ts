import { spawnSync } from "node:child_process";
import path from "node:path";
import { collectDbRlsSuiteFiles } from "../src/test/db-rls-suites";

async function main(): Promise<void> {
  const { candidateCount, selectedSuites } = await collectDbRlsSuiteFiles();
  console.log(
    `Running ${selectedSuites.length} DB-backed RLS Vitest suites from ${candidateCount} candidates`,
  );

  const result = spawnSync(
    process.execPath,
    [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--no-file-parallelism", ...selectedSuites],
    { stdio: "inherit" },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

void main();
