import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(toolRoot, "manifest.json"), "utf8"),
);
const platform = process.platform;
const architecture = os.arch();
const artifact = manifest.artifacts[`${platform}-${architecture}`];

function fail(message) {
  throw new Error(`[supabase-loopback] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    fail(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    fail(`${command} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv.slice(2).filter((arg) => arg !== "--").join(" ") !== "--source-only") {
  fail("usage: pnpm prepare:supabase-loopback -- --source-only");
}
if (!artifact) {
  fail(`unsupported platform ${platform}-${architecture}`);
}

const sourceRoot = path.join(
  toolRoot,
  ".cache",
  manifest.source.tag,
  "source",
);
const artifactRoot = path.dirname(path.join(toolRoot, artifact.binaryPath));
const binaryPath = path.join(toolRoot, artifact.binaryPath);
const receiptPath = path.join(toolRoot, artifact.receiptPath);
const patchPath = path.join(toolRoot, manifest.patch.path);

try {
  await stat(sourceRoot);
  fail(
    `source cache already exists at ${sourceRoot}; remove that exact generated cache before rebuilding`,
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const patch = await readFile(patchPath);
if (sha256(patch) !== manifest.patch.sha256) {
  fail("patch digest does not match manifest");
}

await mkdir(path.dirname(sourceRoot), { recursive: true });
run("git", [
  "clone",
  "--depth",
  "1",
  "--branch",
  manifest.source.tag,
  manifest.source.repository,
  sourceRoot,
]);

const tagObject = run("git", ["rev-parse", manifest.source.tag], {
  cwd: sourceRoot,
});
const sourceCommit = run(
  "git",
  ["rev-parse", `${manifest.source.tag}^{}`],
  { cwd: sourceRoot },
);
const sourceTree = run("git", ["rev-parse", "HEAD^{tree}"], {
  cwd: sourceRoot,
});

if (
  tagObject !== manifest.source.tagObject ||
  sourceCommit !== manifest.source.commit ||
  sourceTree !== manifest.source.tree
) {
  fail("exact source tag, commit, or tree does not match manifest");
}

run("git", ["apply", "--check", patchPath], { cwd: sourceRoot });
run("git", ["apply", patchPath], { cwd: sourceRoot });
run(
  "git",
  [
    "add",
    "apps/cli-go/internal/utils/docker.go",
    "apps/cli-go/internal/utils/loopback/portbindings.go",
    "apps/cli-go/internal/utils/loopback/portbindings_test.go",
  ],
  { cwd: sourceRoot },
);

const patchedTree = run("git", ["write-tree"], { cwd: sourceRoot });
if (patchedTree !== manifest.source.patchedTree) {
  fail(
    `patched source tree mismatch: expected ${manifest.source.patchedTree}, found ${patchedTree}`,
  );
}

const goRoot = path.join(sourceRoot, "apps", "cli-go");
const goEnvironment = {
  ...process.env,
  GOTOOLCHAIN: manifest.build.goVersion,
  CGO_ENABLED: manifest.build.cgoEnabled,
  GOOS: platform,
  GOARCH: architecture,
};

run(
  "go",
  ["test", "./internal/utils/loopback", "-count=1"],
  { cwd: goRoot, env: goEnvironment, stdio: "inherit" },
);

await mkdir(artifactRoot, { recursive: true });
run(
  "go",
  [
    "build",
    "-trimpath",
    "-buildvcs=false",
    `-ldflags=${manifest.build.ldflags}`,
    "-o",
    binaryPath,
    ".",
  ],
  { cwd: goRoot, env: goEnvironment, stdio: "inherit" },
);

const binary = await readFile(binaryPath);
const binaryDigest = sha256(binary);
const binaryStat = await stat(binaryPath);
if (
  binaryDigest !== artifact.binarySha256 ||
  binaryStat.size !== artifact.binarySize
) {
  fail(
    `built binary mismatch for ${platform}-${architecture}: expected ${artifact.binarySha256}/${artifact.binarySize}, found ${binaryDigest}/${binaryStat.size}`,
  );
}

const receipt = {
  schemaVersion: manifest.schemaVersion,
  cliVersion: manifest.cli.version,
  sourceTag: manifest.source.tag,
  sourceTagObject: tagObject,
  sourceCommit,
  sourceTree,
  patchedTree,
  patchSha256: manifest.patch.sha256,
  platform,
  architecture,
  goVersion: manifest.build.goVersion,
  binarySha256: binaryDigest,
  binarySize: binaryStat.size,
};
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

console.log(
  `[supabase-loopback] prepared ${manifest.source.tag} ${platform}-${architecture} ${binaryDigest}`,
);
