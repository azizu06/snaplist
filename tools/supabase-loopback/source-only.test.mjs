import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { preflightSupabase } from "./wrapper.mjs";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolRoot, "..", "..");
const manifest = JSON.parse(
  await readFile(path.join(toolRoot, "manifest.json"), "utf8"),
);
const sourceRoot = path.join(
  toolRoot,
  ".cache",
  manifest.source.tag,
  "source",
);

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GOTOOLCHAIN: manifest.build.goVersion,
      CGO_ENABLED: manifest.build.cgoEnabled,
      GOOS: process.platform,
      GOARCH: process.arch,
    },
  });
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  return result.stdout.trim();
}

async function collectGoFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectGoFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".go")) {
      files.push(entryPath);
    }
  }
  return files;
}

test("stock v2.105.0 fixture proves omitted HostIP RED premise", async () => {
  const fixtureRoot = path.join(
    toolRoot,
    "fixtures",
    "supabase-go-v2.105.0",
  );
  const metadata = JSON.parse(
    await readFile(path.join(fixtureRoot, "source.json"), "utf8"),
  );
  const source = await readFile(
    path.join(fixtureRoot, "start-api-port-binding.go"),
  );

  assert.equal(metadata.tag, manifest.source.tag);
  assert.equal(metadata.commit, manifest.source.commit);
  assert.equal(sha256(source), metadata.excerptSha256);
  assert.doesNotMatch(source.toString("utf8"), /HostIP:/);
});

test("patch applies only to exact tagged source and produces pinned tree", () => {
  assert.equal(
    run("git", ["rev-parse", manifest.source.tag], sourceRoot),
    manifest.source.tagObject,
  );
  assert.equal(
    run("git", ["rev-parse", `${manifest.source.tag}^{}`], sourceRoot),
    manifest.source.commit,
  );
  assert.equal(
    run("git", ["rev-parse", "HEAD^{tree}"], sourceRoot),
    manifest.source.tree,
  );
  assert.equal(
    run("git", ["write-tree"], sourceRoot),
    manifest.source.patchedTree,
  );
});

test("every published-port constructor crosses central dual-loopback guard", async () => {
  const goRoot = path.join(sourceRoot, "apps", "cli-go");
  const productionFiles = (await collectGoFiles(goRoot)).filter(
    (file) => !file.endsWith("_test.go"),
  );
  const containerCreateFiles = [];

  for (const file of productionFiles) {
    const source = await readFile(file, "utf8");
    if (source.includes(".ContainerCreate(")) {
      containerCreateFiles.push(path.relative(goRoot, file));
    }
  }

  assert.deepEqual(containerCreateFiles, ["internal/utils/docker.go"]);

  const dockerSource = await readFile(
    path.join(goRoot, "internal", "utils", "docker.go"),
    "utf8",
  );
  const dockerStartIndex = dockerSource.indexOf("func DockerStart(");
  const nextFunctionIndex = dockerSource.indexOf("\nfunc ", dockerStartIndex + 1);
  const dockerStartSource = dockerSource.slice(
    dockerStartIndex,
    nextFunctionIndex < 0 ? undefined : nextFunctionIndex,
  );
  const guardIndex = dockerStartSource.indexOf(
    "loopback.BindPublishedPorts(hostConfig.PortBindings)",
  );
  const isolationIndex = dockerStartSource.indexOf(
    "isolation.ValidateContainer(config, hostConfig)",
  );
  const networkModeIndex = dockerStartSource.indexOf(
    "hostConfig.NetworkMode = container.NetworkMode(NetId)",
  );
  const pullIndex = dockerStartSource.indexOf("DockerPullImageIfNotCached(");
  const networkCreateIndex = dockerStartSource.indexOf(
    "DockerNetworkCreateIfNotExists(",
  );
  const volumeCreateIndex = dockerStartSource.indexOf("Docker.VolumeCreate(");
  const createIndex = dockerStartSource.indexOf("Docker.ContainerCreate(");
  assert.ok(dockerStartIndex >= 0);
  assert.ok(networkModeIndex >= 0);
  assert.ok(isolationIndex >= 0);
  assert.ok(guardIndex >= 0);
  assert.ok(networkModeIndex < isolationIndex);
  assert.ok(isolationIndex < guardIndex);
  assert.ok(guardIndex < pullIndex);
  assert.ok(pullIndex < networkCreateIndex);
  assert.ok(networkCreateIndex < volumeCreateIndex);
  assert.ok(volumeCreateIndex < createIndex);
  assert.ok(pullIndex < createIndex);

  const patch = await readFile(
    path.join(toolRoot, manifest.patch.path),
    "utf8",
  );
  assert.doesNotMatch(patch, /5432[1-7]/);
});

test("patched pure source rejects unsafe bindings and normalizes future ports", () => {
  const result = spawnSync(
    "go",
    ["test", "./internal/utils/loopback", "-count=1"],
    {
      cwd: path.join(sourceRoot, "apps", "cli-go"),
      encoding: "utf8",
      env: {
        ...process.env,
        GOTOOLCHAIN: manifest.build.goVersion,
        CGO_ENABLED: manifest.build.cgoEnabled,
        GOOS: process.platform,
        GOARCH: process.arch,
      },
    },
  );
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  assert.match(result.stdout, /^ok\s+/);
});

test("patched source rejects Docker host capabilities before side effects", () => {
  const goRoot = path.join(sourceRoot, "apps", "cli-go");
  for (const [packages, testName] of [
    [["./internal/utils/isolation"], "."],
    [["./internal/utils"], "^TestDockerStartRejectsBeforeDockerAction$"],
  ]) {
    const result = spawnSync(
      "go",
      ["test", ...packages, "-run", testName, "-count=1"],
      {
        cwd: goRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GOTOOLCHAIN: manifest.build.goVersion,
          CGO_ENABLED: manifest.build.cgoEnabled,
          GOOS: process.platform,
          GOARCH: process.arch,
        },
      },
    );
    assert.equal(
      result.status,
      0,
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
    assert.match(result.stdout, /^ok\s+/);
  }
});

test("pinned internal override remains first-priority and inherits child environment", async () => {
  const overridePath = path.join(
    sourceRoot,
    manifest.internalOverride.sourcePath,
  );
  const source = await readFile(overridePath, "utf8");

  assert.equal(sha256(source), manifest.internalOverride.sourceSha256);
  const overrideIndex = source.indexOf(
    'const envBin = process.env["SUPABASE_GO_BINARY"];',
  );
  const colocatedIndex = source.indexOf("const colocated =");
  assert.ok(overrideIndex >= 0);
  assert.ok(overrideIndex < colocatedIndex);
  assert.match(source, /if \(envBin\) return \{ found: envBin \};/);
  assert.match(source, /ChildProcess\.make\(binary,/);
  assert.match(source, /env: opts\?\.env,/);
  assert.match(source, /extendEnv: true,/);
});

test("effective project config disables Vector, Logflare, and analytics publication", async () => {
  const config = await readFile(
    path.join(repoRoot, "supabase", "config.toml"),
    "utf8",
  );
  assert.match(
    config,
    /^\[analytics\]\r?\nenabled = false\r?$/m,
  );
  assert.doesNotMatch(
    config,
    /^\[analytics\]\r?\nenabled = true\r?$/m,
  );

  const startSource = await readFile(
    path.join(sourceRoot, "apps", "cli-go", "internal", "start", "start.go"),
    "utf8",
  );
  assert.match(
    startSource,
    /\/\/ Start Logflare\s+if utils\.Config\.Analytics\.Enabled /,
  );
  assert.match(
    startSource,
    /\/\/ Start vector\s+if utils\.Config\.Analytics\.Enabled /,
  );
});

test("all project-owned Supabase entrypoints use fail-closed wrapper", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts.supabase,
    "node tools/supabase-loopback/supabase.mjs",
  );

  const workflowRoot = path.join(repoRoot, ".github", "workflows");
  for (const entry of await readdir(workflowRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const workflow = await readFile(path.join(workflowRoot, entry.name), "utf8");
    for (const line of workflow.split("\n")) {
      const command = line.trim().replace(/^run:\s*/, "");
      if (
        /^(?:(?:pnpm(?:\s+exec)?|npx)\s+)?supabase\s+(?:start|stop|status|test|db|reset)\b/.test(
          command,
        )
      ) {
        assert.match(command, /^pnpm supabase\b/);
      }
      assert.doesNotMatch(command, /^(?:pnpm exec|npx)\s+supabase\b/);
    }
  }
});

test("production preflight accepts only pinned generated artifact", async () => {
  const validated = await preflightSupabase();
  assert.equal(
    validated.binaryPath,
    path.join(
      toolRoot,
      manifest.artifacts[`${process.platform}-${process.arch}`].binaryPath,
    ),
  );
});
