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
const hostGoArchitecture = process.arch === "x64" ? "amd64" : process.arch;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GOTOOLCHAIN: manifest.build.goVersion,
      CGO_ENABLED: manifest.build.cgoEnabled,
      GOOS: process.platform,
      GOARCH: hostGoArchitecture,
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
    "isolation.PrepareContainer(config, hostConfig)",
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
  assert.match(
    dockerSource,
    /func DockerRunJob[\s\S]*?DockerRunOnceWithStream\(/,
  );
  assert.match(
    dockerSource,
    /func DockerRunOnceWithConfig[\s\S]*?DockerStart\(/,
  );

  const databaseStartSource = await readFile(
    path.join(goRoot, "internal", "db", "start", "start.go"),
    "utf8",
  );
  const databaseGuardIndex = databaseStartSource.indexOf(
    "isolation.PrepareContainer(config, hostConfig)",
  );
  const volumeInspectIndex = databaseStartSource.indexOf(
    "Docker.VolumeInspect(ctx, utils.DbId)",
  );
  assert.ok(databaseGuardIndex >= 0);
  assert.ok(volumeInspectIndex >= 0);
  assert.ok(databaseGuardIndex < volumeInspectIndex);

  const startSource = await readFile(
    path.join(goRoot, "internal", "start", "start.go"),
    "utf8",
  );
  assert.doesNotMatch(startSource, /pullImagesUsingCompose/);
  assert.doesNotMatch(startSource, /\.Image(?:Inspect|Pull)\(/);

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
        GOARCH: hostGoArchitecture,
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
    [
      ["./internal/utils"],
      "^(TestDockerStartRejects(BeforeDockerAction|DeviceCgroupRulesBeforeDockerAction|SymlinkedRuntimeSocketSourcesBeforeDockerAction|DirectoryContainingRuntimeEndpointBeforeDockerAction|DirectoryContainingFIFOBeforeDockerAction|HostBindFromUntrustedWritableParentBeforeDockerAction|WritableRegularFileBeforeDockerAction|HostBindReplacedAfterImageInspectionBeforeContainerCreate|HostBindWithDarwinACLBeforeDockerAction)|TestDockerStartUsesCachedImageAndStartsSafeContainer|TestDockerRunOnceRejectsUnsafeConfigBeforeDockerAction)$",
    ],
    [
      ["./internal/db/start"],
      "^(TestStartDatabase(RejectsUnsafeDerivedConfigBeforeDockerAction|FromBackupRejectsSymlinkedRuntimeSocketBeforeDockerAction|FromWritableBackupRejectsBeforeCopyOrDockerAction|FromBackupAllowsOrdinaryRegularFileBeforeDockerAction|FromBackupUsesAbsoluteStagedBind|FromBackupReportsStagingCleanupFailure)?|TestRunFromBackupRejectsSymlinkedRuntimeSocketBeforeDockerAction)$",
    ],
    [
      ["./internal/start"],
      "^(TestRunRejectsUnsafeServiceBeforeDockerAction|TestDockerStartAcceptsDefaultFunctionsServiceDirectory)$",
    ],
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
          GOARCH: hostGoArchitecture,
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

test("Ubuntu database CI prepares the pinned linux-x64 artifact before wrapper use", async () => {
  const artifact = manifest.artifacts["linux-x64"];
  assert.ok(artifact, "manifest must pin linux-x64");
  assert.equal(artifact.platform, "linux");
  assert.equal(artifact.architecture, "x64");
  assert.equal(artifact.platformPackage, "@supabase/cli-linux-x64");
  assert.equal(artifact.platformPackageVersion, manifest.cli.version);
  assert.equal(
    artifact.platformPackageJsonSha256,
    "f6d63e6aa86d98d093d89545b93b8a3f77b19b0dbd8152e9fd633f4e6d011f08",
  );
  assert.equal(
    artifact.platformCliSha256,
    "039206687deb55706063371d7452c0d2b18de1e530dbc783f10b39f5589c3414",
  );

  const binaryPath = path.join(toolRoot, artifact.binaryPath);
  const binary = await readFile(binaryPath);
  assert.equal(binary.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(binary.length, artifact.binarySize);
  assert.equal(sha256(binary), artifact.binarySha256);

  const receipt = JSON.parse(
    await readFile(path.join(toolRoot, artifact.receiptPath), "utf8"),
  );
  assert.deepEqual(
    {
      schemaVersion: receipt.schemaVersion,
      cliVersion: receipt.cliVersion,
      sourceTag: receipt.sourceTag,
      sourceTagObject: receipt.sourceTagObject,
      sourceCommit: receipt.sourceCommit,
      sourceTree: receipt.sourceTree,
      patchedTree: receipt.patchedTree,
      patchSha256: receipt.patchSha256,
      platform: receipt.platform,
      architecture: receipt.architecture,
      goVersion: receipt.goVersion,
      binarySha256: receipt.binarySha256,
      binarySize: receipt.binarySize,
    },
    {
      schemaVersion: manifest.schemaVersion,
      cliVersion: manifest.cli.version,
      sourceTag: manifest.source.tag,
      sourceTagObject: manifest.source.tagObject,
      sourceCommit: manifest.source.commit,
      sourceTree: manifest.source.tree,
      patchedTree: manifest.source.patchedTree,
      patchSha256: manifest.patch.sha256,
      platform: artifact.platform,
      architecture: artifact.architecture,
      goVersion: manifest.build.goVersion,
      binarySha256: artifact.binarySha256,
      binarySize: artifact.binarySize,
    },
  );

  const buildInfo = spawnSync("go", ["version", "-m", binaryPath], {
    encoding: "utf8",
  });
  assert.equal(buildInfo.status, 0, buildInfo.stderr);
  assert.match(buildInfo.stdout, new RegExp(`\\b${manifest.build.goVersion}\\b`));
  assert.match(
    manifest.build.ldflags,
    /github\.com\/supabase\/cli\/internal\/utils\.Version=2\.105\.0/,
  );
  if (process.platform === "linux" && process.arch === "x64") {
    const version = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /\b2\.105\.0\b/);
  }

  const workflow = await readFile(
    path.join(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const databaseStart = workflow.indexOf("  database:");
  const databaseEnd = workflow.indexOf("\n  image:", databaseStart);
  const databaseJob = workflow.slice(databaseStart, databaseEnd);
  const setupGoIndex = databaseJob.indexOf("uses: actions/setup-go@v5");
  const installIndex = databaseJob.indexOf("run: pnpm install --frozen-lockfile");
  const prepareIndex = databaseJob.indexOf(
    "run: pnpm prepare:supabase-loopback -- --source-only",
  );
  const wrapperIndex = databaseJob.indexOf("pnpm supabase start");

  assert.ok(setupGoIndex >= 0);
  assert.match(databaseJob, /go-version:\s*["']?1\.25\.5["']?/);
  assert.ok(setupGoIndex < installIndex);
  assert.ok(installIndex < prepareIndex);
  assert.ok(prepareIndex < wrapperIndex);
});
