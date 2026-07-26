import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { preflightSupabase, runSupabase } from "./wrapper.mjs";

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "snaplist-loopback-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const files = {
    patch: Buffer.from("loopback patch\n"),
    binary: Buffer.from("patched supabase-go\n"),
    cliPackage: Buffer.from(
      `${JSON.stringify({ name: "supabase", version: "2.105.0" })}\n`,
    ),
    cliShim: Buffer.from("supabase shim\n"),
    platformPackage: Buffer.from(
      `${JSON.stringify({
        name: "@supabase/cli-darwin-arm64",
        version: "2.105.0",
      })}\n`,
    ),
    platformCli: Buffer.from("platform cli\n"),
  };
  const paths = {
    patchPath: path.join(root, "patch.diff"),
    binaryPath: path.join(root, ".cache", "supabase-go"),
    receiptPath: path.join(root, ".cache", "build-receipt.json"),
    cliPackageJsonPath: path.join(root, "supabase-package.json"),
    cliShimPath: path.join(root, "supabase-shim"),
    platformPackageJsonPath: path.join(root, "platform-package.json"),
    platformCliPath: path.join(root, "platform-cli"),
  };

  await mkdir(path.dirname(paths.binaryPath), { recursive: true });
  await Promise.all([
    writeFile(paths.patchPath, files.patch),
    writeFile(paths.binaryPath, files.binary),
    writeFile(paths.cliPackageJsonPath, files.cliPackage),
    writeFile(paths.cliShimPath, files.cliShim),
    writeFile(paths.platformPackageJsonPath, files.platformPackage),
    writeFile(paths.platformCliPath, files.platformCli),
  ]);

  const manifest = {
    schemaVersion: 1,
    cli: {
      package: "supabase",
      version: "2.105.0",
      integrity:
        "sha512-UB2aFLYAVujTQsZ9l+aCbDfLNaZApZucByRNP/1j0L1pXXzFhSgEyZSrvHSUO5LIvOb09AGHWishL/usVTuHTg==",
      packageJsonSha256: sha256(files.cliPackage),
      shimSha256: sha256(files.cliShim),
    },
    source: {
      repository: "https://github.com/supabase/cli.git",
      tag: "v2.105.0",
      tagObject: "6b84c68f097184b3221dc44c8cee45d3ccb0d7c1",
      commit: "b749d52b8e86813dfbcef4b34d0f038b78695131",
      tree: "b98153e6684637de7da209e511614bd36c7a5f01",
      patchedTree: "613430325d807fdfc71c4a29ebd31e87020b74a7",
    },
    patch: {
      path: path.relative(root, paths.patchPath),
      sha256: sha256(files.patch),
    },
    internalOverride: {
      environmentVariable: "SUPABASE_GO_BINARY",
      sourcePath: "apps/cli/src/shared/legacy/go-proxy.layer.ts",
      sourceSha256:
        "f562172096a1c9f2d10fec61451bf5df79750174fabc9aa97fef465b1d899003",
      resolutionPriority: 1,
      childEnvironment: "inherited",
    },
    build: {
      goVersion: "go1.25.5",
      cgoEnabled: "0",
      trimpath: true,
      buildVcs: false,
      ldflags:
        "-s -w -X github.com/supabase/cli/internal/utils.Version=2.105.0",
    },
    artifacts: {
      "darwin-arm64": {
        platform: "darwin",
        architecture: "arm64",
        platformPackage: "@supabase/cli-darwin-arm64",
        platformPackageVersion: "2.105.0",
        platformPackageJsonSha256: sha256(files.platformPackage),
        platformCliSha256: sha256(files.platformCli),
        binaryPath: path.relative(root, paths.binaryPath),
        binarySha256: sha256(files.binary),
        binarySize: files.binary.length,
        receiptPath: path.relative(root, paths.receiptPath),
      },
    },
  };

  const receipt = {
    schemaVersion: 1,
    cliVersion: manifest.cli.version,
    sourceTag: manifest.source.tag,
    sourceTagObject: manifest.source.tagObject,
    sourceCommit: manifest.source.commit,
    sourceTree: manifest.source.tree,
    patchedTree: manifest.source.patchedTree,
    patchSha256: manifest.patch.sha256,
    platform: "darwin",
    architecture: "arm64",
    goVersion: manifest.build.goVersion,
    binarySha256: manifest.artifacts["darwin-arm64"].binarySha256,
    binarySize: manifest.artifacts["darwin-arm64"].binarySize,
  };
  await writeFile(paths.receiptPath, `${JSON.stringify(receipt)}\n`);

  const artifact = manifest.artifacts["darwin-arm64"];
  const contract = {
    schemaVersion: manifest.schemaVersion,
    cliVersion: manifest.cli.version,
    cliIntegrity: manifest.cli.integrity,
    cliPackageJsonSha256: manifest.cli.packageJsonSha256,
    cliShimSha256: manifest.cli.shimSha256,
    sourceRepository: manifest.source.repository,
    sourceTag: manifest.source.tag,
    sourceTagObject: manifest.source.tagObject,
    sourceCommit: manifest.source.commit,
    sourceTree: manifest.source.tree,
    patchedTree: manifest.source.patchedTree,
    patchPath: manifest.patch.path,
    patchSha256: manifest.patch.sha256,
    overrideVariable: manifest.internalOverride.environmentVariable,
    overrideSourcePath: manifest.internalOverride.sourcePath,
    overrideSourceSha256: manifest.internalOverride.sourceSha256,
    overrideResolutionPriority: manifest.internalOverride.resolutionPriority,
    overrideChildEnvironment: manifest.internalOverride.childEnvironment,
    goVersion: manifest.build.goVersion,
    cgoEnabled: manifest.build.cgoEnabled,
    trimpath: manifest.build.trimpath,
    buildVcs: manifest.build.buildVcs,
    ldflags: manifest.build.ldflags,
    artifacts: {
      "darwin-arm64": {
        platform: artifact.platform,
        architecture: artifact.architecture,
        platformPackage: artifact.platformPackage,
        platformPackageVersion: artifact.platformPackageVersion,
        platformPackageJsonSha256: artifact.platformPackageJsonSha256,
        platformCliSha256: artifact.platformCliSha256,
        binaryPath: artifact.binaryPath,
        binarySha256: artifact.binarySha256,
        binarySize: artifact.binarySize,
        receiptPath: artifact.receiptPath,
      },
    },
  };

  return {
    root,
    manifest,
    paths,
    options: {
      manifest,
      toolRoot: root,
      platform: "darwin",
      architecture: "arm64",
      cliPaths: paths,
      contract,
    },
  };
}

test("preflight rejects every source, manifest, platform, and artifact mismatch", async (t) => {
  const cases = [
    ["wrong source tag", (fixture) => (fixture.manifest.source.tag = "v2.105.1")],
    ["wrong CLI version", (fixture) => (fixture.manifest.cli.version = "2.104.0")],
    ["unsupported platform", (fixture) => (fixture.options.platform = "linux")],
    [
      "wrong binary digest",
      (fixture) =>
        (fixture.manifest.artifacts["darwin-arm64"].binarySha256 = "0".repeat(64)),
    ],
    ["wrong patch digest", async (fixture) => writeFile(fixture.paths.patchPath, "changed\n")],
    ["missing binary", async (fixture) => rm(fixture.paths.binaryPath)],
    ["missing cache receipt", async (fixture) => rm(fixture.paths.receiptPath)],
    [
      "wrong platform package",
      async (fixture) =>
        writeFile(
          fixture.paths.platformPackageJsonPath,
          `${JSON.stringify({
            name: "@supabase/cli-darwin-arm64",
            version: "2.104.0",
          })}\n`,
        ),
    ],
    [
      "wrong binary version",
      async (fixture) => {
        const receipt = JSON.parse(
          await readFile(fixture.paths.receiptPath, "utf8"),
        );
        receipt.cliVersion = "2.104.0";
        await writeFile(
          fixture.paths.receiptPath,
          `${JSON.stringify(receipt)}\n`,
        );
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t);
      await mutate(fixture);
      await assert.rejects(preflightSupabase(fixture.options));
    });
  }
});

test("wrapper exports validated SUPABASE_GO_BINARY and blocks stock fallback", async (t) => {
  const fixture = await makeFixture(t);
  const calls = [];

  const result = await runSupabase(["--version"], {
    ...fixture.options,
    processEnvironment: { SNAPLIST_SAFE: "preserved" },
    invokeCli: async (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].options.env.SUPABASE_GO_BINARY,
    fixture.paths.binaryPath,
  );
  assert.equal(
    calls[0].options.env.SUPABASE_CLI_BINARY_OVERRIDE,
    fixture.paths.platformCliPath,
  );
  assert.equal(calls[0].options.env.SNAPLIST_SAFE, "preserved");

  for (const variable of [
    "SUPABASE_GO_BINARY",
    "SUPABASE_CLI_BINARY_OVERRIDE",
  ]) {
    await assert.rejects(
      runSupabase(["--version"], {
        ...fixture.options,
        processEnvironment: { [variable]: "/unsafe/stock" },
        invokeCli: async () => {
          throw new Error("CLI must not run");
        },
      }),
      /refuses caller-provided/,
    );
  }
});

test("wrapper rejects caller Docker transport overrides before child spawn", async (t) => {
  for (const variable of ["DOCKER_HOST", "DOCKER_CONTEXT"]) {
    await t.test(variable, async (t) => {
      const fixture = await makeFixture(t);
      let childSpawned = false;

      await assert.rejects(
        runSupabase(["--version"], {
          ...fixture.options,
          processEnvironment: { [variable]: "caller-controlled" },
          invokeCli: async () => {
            childSpawned = true;
            return { status: 0 };
          },
        }),
        new RegExp(`refuses caller-provided ${variable}`),
      );
      assert.equal(childSpawned, false);
    });
  }
});

test("wrapper rejects unsafe effective Analytics config before child spawn", async (t) => {
  const cases = [
    ["missing analytics block", "[api]\nport = 54321\n"],
    ["analytics enabled", "[analytics]\nenabled = true\n"],
    ["malformed analytics flag", '[analytics]\nenabled = "false"\n'],
  ];

  for (const [name, config] of cases) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t);
      const supabaseRoot = path.join(fixture.root, "supabase");
      await mkdir(supabaseRoot);
      await writeFile(path.join(supabaseRoot, "config.toml"), config);
      let childSpawned = false;

      await assert.rejects(
        runSupabase(["start", "--workdir", fixture.root], {
          ...fixture.options,
          processEnvironment: {},
          invokeCli: async () => {
            childSpawned = true;
            return { status: 0 };
          },
        }),
        /analytics/i,
      );
      assert.equal(childSpawned, false);
    });
  }

  const fixture = await makeFixture(t);
  const supabaseRoot = path.join(fixture.root, "supabase");
  await mkdir(supabaseRoot);
  await writeFile(
    path.join(supabaseRoot, "config.toml"),
    "[analytics]\nenabled = false\n",
  );
  const calls = [];
  await runSupabase(["start", "--workdir", fixture.root], {
    ...fixture.options,
    processEnvironment: {},
    invokeCli: async (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].options.env.SUPABASE_GO_BINARY,
    fixture.paths.binaryPath,
  );
});

test("wrapper rejects caller host-network override before child spawn", async (t) => {
  for (const args of [
    ["start", "--network-id", "host"],
    ["start", "--network-id=host"],
  ]) {
    await t.test(args.at(-1), async (t) => {
      const fixture = await makeFixture(t);
      const supabaseRoot = path.join(fixture.root, "supabase");
      await mkdir(supabaseRoot);
      await writeFile(
        path.join(supabaseRoot, "config.toml"),
        "[analytics]\nenabled = false\n",
      );
      let childSpawned = false;

      await assert.rejects(
        runSupabase([...args, "--workdir", fixture.root], {
          ...fixture.options,
          processEnvironment: {},
          invokeCli: async () => {
            childSpawned = true;
            return { status: 0 };
          },
        }),
        /host network/i,
      );
      assert.equal(childSpawned, false);
    });
  }
});
