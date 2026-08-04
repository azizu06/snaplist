import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface TestFile {
  content: string;
  path: string;
}

const unreachableStackFixture = "src/test/fixtures/supabase-stack-unreachable.test.ts";

function usesSharedSupabaseStack(file: TestFile): boolean {
  return /^\s*import\s+(?:[^;]*?\s+from\s+)?["']@\/test\/supabase-stack["']/m.test(file.content);
}

function isDbBackedRlsCandidate(file: TestFile): boolean {
  return file.path.endsWith(".rls.test.ts") || usesSharedSupabaseStack(file);
}

export function selectDbRlsSuites(files: readonly TestFile[]): string[] {
  return files
    .filter(isDbBackedRlsCandidate)
    .filter((file) => file.path !== unreachableStackFixture)
    .map((file) => file.path)
    .sort();
}

export function assertDbRlsSuiteSelection(
  candidateCount: number,
  selectedSuites: readonly string[],
): void {
  if (candidateCount > 0 && selectedSuites.length === 0) {
    throw new Error(
      `DB-backed RLS suite selection found ${candidateCount} candidates but selected none`,
    );
  }
}

async function collectTestPaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTestPaths(entryPath);
    return entry.name.endsWith(".test.ts") ? [entryPath] : [];
  }));

  return nested.flat();
}

export async function collectDbRlsSuiteFiles(): Promise<{
  candidateCount: number;
  selectedSuites: string[];
}> {
  const testPaths = await collectTestPaths("src");
  const files = await Promise.all(testPaths.map(async (testPath) => ({
    content: await readFile(testPath, "utf8"),
    path: testPath.split(path.sep).join("/"),
  })));
  const candidateCount = files.filter(isDbBackedRlsCandidate).length;
  const selectedSuites = selectDbRlsSuites(files);

  assertDbRlsSuiteSelection(candidateCount, selectedSuites);
  return { candidateCount, selectedSuites };
}
