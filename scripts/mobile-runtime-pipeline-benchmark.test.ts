import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const fixturePaths = [
  "public/demo/headphones.jpg",
  "public/demo/camera.jpg",
  "public/demo/macbook.jpg",
  "public/demo/book.jpg",
] as const;

const repoRoot = resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

function quotedFixturePaths(source: string): string[] {
  return Array.from(source.matchAll(/"(public\/demo\/[^"]+)"/g), ([, fixture]) => fixture);
}

function dockerFixturePaths(source: string): string[] {
  const fixtureCopy = source
    .split("\n")
    .find((line) => line.startsWith("COPY ") && line.includes("public/demo/"));

  return fixtureCopy?.match(/public\/demo\/[^\s]+/g) ?? [];
}

describe("mobile runtime pipeline benchmark fixture contract", () => {
  it("keeps every declared benchmark input tracked and readable as a JPEG", async () => {
    await Promise.all(
      fixturePaths.map(async (fixture) => {
        const file = resolve(repoRoot, fixture);
        await expect(
          execFileAsync("git", ["ls-files", "--error-unmatch", fixture], {
            cwd: repoRoot,
          }),
        ).resolves.toBeDefined();
        await expect(access(file)).resolves.toBeUndefined();

        const bytes = await readFile(file);
        expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      }),
    );
  });

  it("keeps the benchmark script and proof Dockerfile on exactly those inputs", async () => {
    const [benchmarkScript, proofDockerfile] = await Promise.all([
      readFile(resolve(repoRoot, "scripts/mobile-runtime-pipeline-benchmark.ts"), "utf8"),
      readFile(resolve(repoRoot, "Dockerfile.mobile-runtime-proof"), "utf8"),
    ]);

    expect(quotedFixturePaths(benchmarkScript)).toEqual(fixturePaths);
    expect(dockerFixturePaths(proofDockerfile)).toEqual(fixturePaths);
  });
});
