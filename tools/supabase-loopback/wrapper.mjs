import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolRoot, "..", "..");
const require = createRequire(import.meta.url);

export const DEFAULT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  cliVersion: "2.105.0",
  cliIntegrity:
    "sha512-UB2aFLYAVujTQsZ9l+aCbDfLNaZApZucByRNP/1j0L1pXXzFhSgEyZSrvHSUO5LIvOb09AGHWishL/usVTuHTg==",
  cliPackageJsonSha256:
    "eb22fd042399352b8abf4581c5b9f33932703e5a78315913130914f0ca8542a4",
  cliShimSha256:
    "253caa8c31ee5976322d04a8bd7752622c0915e7943de3f74e2b73395c54a240",
  sourceRepository: "https://github.com/supabase/cli.git",
  sourceTag: "v2.105.0",
  sourceTagObject: "6b84c68f097184b3221dc44c8cee45d3ccb0d7c1",
  sourceCommit: "b749d52b8e86813dfbcef4b34d0f038b78695131",
  sourceTree: "b98153e6684637de7da209e511614bd36c7a5f01",
  patchedTree: "b21eada0edc5cc19fafb8447bb696c429f869264",
  patchPath: "patches/supabase-go-v2.105.0-loopback.patch",
  patchSha256:
    "dc5f20aa59266831411984edae2dc8dd7922fe03351fda3c741468352b104717",
  overrideVariable: "SUPABASE_GO_BINARY",
  overrideSourcePath: "apps/cli/src/shared/legacy/go-proxy.layer.ts",
  overrideSourceSha256:
    "f562172096a1c9f2d10fec61451bf5df79750174fabc9aa97fef465b1d899003",
  overrideResolutionPriority: 1,
  overrideChildEnvironment: "inherited",
  goVersion: "go1.25.5",
  cgoEnabled: "0",
  trimpath: true,
  buildVcs: false,
  ldflags:
    "-s -w -X github.com/supabase/cli/internal/utils.Version=2.105.0",
  artifacts: {
    "darwin-arm64": {
      platform: "darwin",
      architecture: "arm64",
      platformPackage: "@supabase/cli-darwin-arm64",
      platformPackageVersion: "2.105.0",
      platformPackageJsonSha256:
        "57fa6eb86f67b62f32b9d65811c3f1403fd3e9635a3ef83c8a1ec047f0f0c945",
      platformCliSha256:
        "635c7f8360df5f098628a0ee1c1d489fb8e45e0a7ca7d1b1299cce51c1e1e184",
      binaryPath: ".cache/v2.105.0/darwin-arm64/supabase-go",
      binarySha256:
        "50308ab755d30eb69db578d1b44da4f9d29e5e5b9e67277264f99cb75f9d41b6",
      binarySize: 47613426,
      receiptPath:
        ".cache/v2.105.0/darwin-arm64/build-receipt.json",
    },
    "linux-x64": {
      platform: "linux",
      architecture: "x64",
      platformPackage: "@supabase/cli-linux-x64",
      platformPackageVersion: "2.105.0",
      platformPackageJsonSha256:
        "f6d63e6aa86d98d093d89545b93b8a3f77b19b0dbd8152e9fd633f4e6d011f08",
      platformCliSha256:
        "039206687deb55706063371d7452c0d2b18de1e530dbc783f10b39f5589c3414",
      binaryPath: ".cache/v2.105.0/linux-x64/supabase-go",
      binarySha256:
        "3b834bb20ac7185aba20cb7dd11a1b22d4ce72747898579725134e5eb43e5440",
      binarySize: 49578168,
      receiptPath:
        ".cache/v2.105.0/linux-x64/build-receipt.json",
    },
  },
});

function fail(message) {
  throw new Error(`[supabase-loopback] ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readRequired(filePath, label) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) fail(`${label} is not a file: ${filePath}`);
    return await readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") fail(`missing ${label}: ${filePath}`);
    throw error;
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} mismatch: expected ${expected}, found ${actual}`);
  }
}

function resolveWorkdir(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workdir") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        fail("--workdir requires exactly one path");
      }
      values.push(value);
      index += 1;
    } else if (arg.startsWith("--workdir=")) {
      values.push(arg.slice("--workdir=".length));
    }
  }
  if (values.length > 1) fail("wrapper refuses multiple --workdir values");
  if (values.length === 0) return repoRoot;
  if (values[0].length === 0) fail("--workdir requires exactly one path");
  return path.resolve(values[0]);
}

function rejectUnsafeNetworkOverride(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--network-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        fail("--network-id requires exactly one value");
      }
      values.push(value);
      index += 1;
    } else if (arg.startsWith("--network-id=")) {
      values.push(arg.slice("--network-id=".length));
    }
  }
  if (values.length > 1) fail("wrapper refuses multiple --network-id values");
  if (values.some((value) => value === "host")) {
    fail("wrapper refuses caller-provided host network");
  }
}

function parseAnalyticsDisabled(config) {
  let inAnalytics = false;
  let analyticsSections = 0;
  let enabledValues = 0;

  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const section = trimmed.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      inAnalytics = section[1].trim() === "analytics";
      if (inAnalytics) analyticsSections += 1;
      continue;
    }
    if (!inAnalytics) continue;

    const enabled = trimmed.match(/^enabled\s*=\s*(\S+)(?:\s+#.*)?$/);
    if (!enabled) continue;
    enabledValues += 1;
    if (enabled[1] !== "false") {
      fail('effective [analytics] enabled must be the boolean literal false');
    }
  }

  if (analyticsSections !== 1 || enabledValues !== 1) {
    fail(
      "effective Supabase config must contain exactly one [analytics] block with enabled = false",
    );
  }
}

async function preflightAnalytics(args) {
  const workdir = resolveWorkdir(args);
  const configPath = path.join(workdir, "supabase", "config.toml");
  const config = await readRequired(configPath, "effective Supabase config");
  parseAnalyticsDisabled(config.toString("utf8"));
}

function resolveInstalledCli(artifact) {
  const cliPackageJsonPath = require.resolve("supabase/package.json");
  const cliPackageRoot = path.dirname(cliPackageJsonPath);
  const cliPackage = createRequire(cliPackageJsonPath);
  const platformPackageJsonPath = cliPackage.resolve(
    `${artifact.platformPackage}/package.json`,
  );
  const platformPackageRoot = path.dirname(platformPackageJsonPath);
  const extension = process.platform === "win32" ? ".exe" : "";

  return {
    cliPackageJsonPath,
    cliShimPath: path.join(cliPackageRoot, "dist", "supabase.js"),
    platformPackageJsonPath,
    platformCliPath: path.join(
      platformPackageRoot,
      "bin",
      `supabase${extension}`,
    ),
  };
}

function assertManifest(manifest, contract, platformKey) {
  const artifact = manifest.artifacts?.[platformKey];
  const contractArtifact = contract.artifacts?.[platformKey];
  if (!artifact || !contractArtifact) {
    fail(`unsupported platform ${platformKey}`);
  }

  assertEqual(manifest.schemaVersion, contract.schemaVersion, "manifest schema");
  assertEqual(manifest.cli?.version, contract.cliVersion, "CLI version");
  assertEqual(manifest.cli?.integrity, contract.cliIntegrity, "CLI integrity");
  assertEqual(
    manifest.cli?.packageJsonSha256,
    contract.cliPackageJsonSha256,
    "CLI package manifest digest",
  );
  assertEqual(
    manifest.cli?.shimSha256,
    contract.cliShimSha256,
    "CLI shim digest",
  );
  assertEqual(
    manifest.source?.repository,
    contract.sourceRepository,
    "source repository",
  );
  assertEqual(manifest.source?.tag, contract.sourceTag, "source tag");
  assertEqual(
    manifest.source?.tagObject,
    contract.sourceTagObject,
    "source tag object",
  );
  assertEqual(
    manifest.source?.commit,
    contract.sourceCommit,
    "source commit",
  );
  assertEqual(manifest.source?.tree, contract.sourceTree, "source tree");
  assertEqual(
    manifest.source?.patchedTree,
    contract.patchedTree,
    "patched source tree",
  );
  assertEqual(manifest.patch?.path, contract.patchPath, "patch path");
  assertEqual(manifest.patch?.sha256, contract.patchSha256, "patch digest");
  assertEqual(
    manifest.internalOverride?.environmentVariable,
    contract.overrideVariable,
    "internal override variable",
  );
  assertEqual(
    manifest.internalOverride?.sourcePath,
    contract.overrideSourcePath,
    "internal override source path",
  );
  assertEqual(
    manifest.internalOverride?.sourceSha256,
    contract.overrideSourceSha256,
    "internal override source digest",
  );
  assertEqual(
    manifest.internalOverride?.resolutionPriority,
    contract.overrideResolutionPriority,
    "internal override resolution priority",
  );
  assertEqual(
    manifest.internalOverride?.childEnvironment,
    contract.overrideChildEnvironment,
    "internal override child environment",
  );
  assertEqual(manifest.build?.goVersion, contract.goVersion, "Go version");
  assertEqual(manifest.build?.cgoEnabled, contract.cgoEnabled, "CGO setting");
  assertEqual(manifest.build?.trimpath, contract.trimpath, "trimpath setting");
  assertEqual(manifest.build?.buildVcs, contract.buildVcs, "build VCS setting");
  assertEqual(manifest.build?.ldflags, contract.ldflags, "linker flags");
  assertEqual(artifact.platform, contractArtifact.platform, "artifact platform");
  assertEqual(
    artifact.architecture,
    contractArtifact.architecture,
    "artifact architecture",
  );
  assertEqual(
    artifact.platformPackage,
    contractArtifact.platformPackage,
    "platform package",
  );
  assertEqual(
    artifact.platformPackageVersion,
    contractArtifact.platformPackageVersion,
    "platform package version",
  );
  assertEqual(
    artifact.platformPackageJsonSha256,
    contractArtifact.platformPackageJsonSha256,
    "platform package manifest digest",
  );
  assertEqual(
    artifact.platformCliSha256,
    contractArtifact.platformCliSha256,
    "platform CLI digest",
  );
  assertEqual(
    artifact.binaryPath,
    contractArtifact.binaryPath,
    "patched binary path",
  );
  assertEqual(
    artifact.binarySha256,
    contractArtifact.binarySha256,
    "patched binary digest",
  );
  assertEqual(
    artifact.binarySize,
    contractArtifact.binarySize,
    "patched binary size",
  );
  assertEqual(
    artifact.receiptPath,
    contractArtifact.receiptPath,
    "build receipt path",
  );
  return artifact;
}

export async function preflightSupabase(options = {}) {
  const root = options.toolRoot ?? toolRoot;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? os.arch();
  const platformKey = `${platform}-${architecture}`;
  const manifest =
    options.manifest ??
    JSON.parse(
      await readFile(path.join(root, "manifest.json"), "utf8"),
    );
  const contract = options.contract ?? DEFAULT_CONTRACT;
  const artifact = assertManifest(manifest, contract, platformKey);
  const paths = options.cliPaths ?? resolveInstalledCli(artifact);
  const patchPath = path.join(root, manifest.patch.path);
  const binaryPath = path.join(root, artifact.binaryPath);
  const receiptPath = path.join(root, artifact.receiptPath);

  const [
    patch,
    binary,
    receiptBytes,
    cliPackageBytes,
    cliShim,
    platformPackageBytes,
    platformCli,
  ] = await Promise.all([
    readRequired(patchPath, "patch"),
    readRequired(binaryPath, "patched binary"),
    readRequired(receiptPath, "build receipt"),
    readRequired(paths.cliPackageJsonPath, "CLI package manifest"),
    readRequired(paths.cliShimPath, "CLI shim"),
    readRequired(paths.platformPackageJsonPath, "platform package manifest"),
    readRequired(paths.platformCliPath, "platform CLI"),
  ]);

  assertEqual(sha256(patch), manifest.patch.sha256, "patch digest");
  assertEqual(sha256(binary), artifact.binarySha256, "patched binary digest");
  assertEqual(binary.length, artifact.binarySize, "patched binary size");
  assertEqual(
    sha256(cliPackageBytes),
    manifest.cli.packageJsonSha256,
    "CLI package manifest digest",
  );
  assertEqual(sha256(cliShim), manifest.cli.shimSha256, "CLI shim digest");
  assertEqual(
    sha256(platformPackageBytes),
    artifact.platformPackageJsonSha256,
    "platform package manifest digest",
  );
  assertEqual(
    sha256(platformCli),
    artifact.platformCliSha256,
    "platform CLI digest",
  );

  const cliPackage = JSON.parse(cliPackageBytes);
  const platformPackage = JSON.parse(platformPackageBytes);
  assertEqual(cliPackage.name, manifest.cli.package, "CLI package name");
  assertEqual(cliPackage.version, manifest.cli.version, "installed CLI version");
  assertEqual(
    platformPackage.name,
    artifact.platformPackage,
    "platform package name",
  );
  assertEqual(
    platformPackage.version,
    artifact.platformPackageVersion,
    "platform package version",
  );

  const receipt = JSON.parse(receiptBytes);
  const receiptContract = {
    schemaVersion: manifest.schemaVersion,
    cliVersion: manifest.cli.version,
    sourceTag: manifest.source.tag,
    sourceTagObject: manifest.source.tagObject,
    sourceCommit: manifest.source.commit,
    sourceTree: manifest.source.tree,
    patchedTree: manifest.source.patchedTree,
    patchSha256: manifest.patch.sha256,
    platform,
    architecture,
    goVersion: manifest.build.goVersion,
    binarySha256: artifact.binarySha256,
    binarySize: artifact.binarySize,
  };
  for (const [key, expected] of Object.entries(receiptContract)) {
    assertEqual(receipt[key], expected, `build receipt ${key}`);
  }

  return {
    binaryPath,
    cliShimPath: paths.cliShimPath,
    platformCliPath: paths.platformCliPath,
  };
}

export async function runSupabase(args, options = {}) {
  const processEnvironment =
    options.processEnvironment ?? process.env;
  for (const variable of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "SUPABASE_GO_BINARY",
    "SUPABASE_CLI_BINARY_OVERRIDE",
  ]) {
    if (Object.hasOwn(processEnvironment, variable)) {
      fail(`wrapper refuses caller-provided ${variable}`);
    }
  }

  rejectUnsafeNetworkOverride(args);
  await preflightAnalytics(args);
  const validated = await preflightSupabase(options);
  const environment = {
    ...processEnvironment,
    SUPABASE_GO_BINARY: validated.binaryPath,
    SUPABASE_CLI_BINARY_OVERRIDE: validated.platformCliPath,
  };
  const invokeCli =
    options.invokeCli ??
    (async (command, childArgs, childOptions) =>
      spawnSync(command, childArgs, {
        ...childOptions,
        stdio: "inherit",
      }));
  const result = await invokeCli(
    process.execPath,
    [validated.cliShimPath, ...args],
    { env: environment },
  );
  if (result.error) fail(`CLI invocation failed: ${result.error.message}`);
  if (typeof result.status !== "number") {
    fail("CLI invocation ended without an exit status");
  }
  return result;
}
