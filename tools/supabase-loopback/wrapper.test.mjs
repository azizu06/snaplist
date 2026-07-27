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

async function writeSafeAnalyticsConfig(root) {
  const supabaseRoot = path.join(root, "supabase");
  await mkdir(supabaseRoot, { recursive: true });
  await writeFile(
    path.join(supabaseRoot, "config.toml"),
    "[analytics]\nenabled = false\n",
  );
}

async function defaultDockerEnvironment(fixture, extra = {}) {
  const home = path.join(fixture.root, "home");
  await mkdir(path.join(home, ".docker"), { recursive: true });
  return { HOME: home, ...extra };
}

async function writeDockerContext(configRoot, name, metadata) {
  await mkdir(configRoot, { recursive: true });
  await writeFile(
    path.join(configRoot, "config.json"),
    `${JSON.stringify({ currentContext: name })}\n`,
  );
  const metadataRoot = path.join(
    configRoot,
    "contexts",
    "meta",
    sha256(name),
  );
  await mkdir(metadataRoot, { recursive: true });
  await writeFile(
    path.join(metadataRoot, "meta.json"),
    typeof metadata === "string"
      ? metadata
      : `${JSON.stringify(metadata)}\n`,
  );
}

function dockerContextMetadata(name, host) {
  return {
    Name: name,
    Metadata: {},
    Endpoints: {
      docker: {
        Host: host,
        SkipTLSVerify: false,
      },
    },
  };
}

async function configureFixturePlatform(fixture, platform, architecture) {
  const platformKey = `${platform}-${architecture}`;
  const packageName = `@supabase/cli-${platformKey}`;
  const packageBytes = Buffer.from(
    `${JSON.stringify({ name: packageName, version: "2.105.0" })}\n`,
  );
  await writeFile(fixture.paths.platformPackageJsonPath, packageBytes);

  const darwinArtifact = fixture.manifest.artifacts["darwin-arm64"];
  const artifact = {
    ...darwinArtifact,
    platform,
    architecture,
    platformPackage: packageName,
    platformPackageJsonSha256: sha256(packageBytes),
  };
  fixture.manifest.artifacts = { [platformKey]: artifact };
  fixture.options.contract.artifacts = {
    [platformKey]: {
      ...fixture.options.contract.artifacts["darwin-arm64"],
      platform,
      architecture,
      platformPackage: packageName,
      platformPackageJsonSha256: sha256(packageBytes),
    },
  };
  fixture.options.platform = platform;
  fixture.options.architecture = architecture;

  const receipt = JSON.parse(
    await readFile(fixture.paths.receiptPath, "utf8"),
  );
  receipt.platform = platform;
  receipt.architecture = architecture;
  await writeFile(
    fixture.paths.receiptPath,
    `${JSON.stringify(receipt)}\n`,
  );
}

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
      "wrong platform package digest",
      async (fixture) =>
        writeFile(
          fixture.paths.platformPackageJsonPath,
          `${JSON.stringify({
            name: "@supabase/cli-darwin-arm64",
            version: "2.105.0",
            changed: true,
          })}\n`,
        ),
    ],
    [
      "wrong platform CLI digest",
      async (fixture) =>
        writeFile(fixture.paths.platformCliPath, "changed platform CLI\n"),
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
    [
      "wrong receipt platform",
      async (fixture) => {
        const receipt = JSON.parse(
          await readFile(fixture.paths.receiptPath, "utf8"),
        );
        receipt.platform = "linux";
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
    processEnvironment: await defaultDockerEnvironment(fixture, {
      SNAPLIST_SAFE: "preserved",
    }),
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

test("wrapper resolves only local Unix Docker contexts before child spawn", async (t) => {
  const blocked = [
    {
      name: "TCP currentContext through DOCKER_CONFIG",
      context: "remote-tcp",
      host: "tcp://docker.example.test:2376",
      useDockerConfig: true,
    },
    {
      name: "SSH currentContext through default HOME config",
      context: "remote-ssh",
      host: "ssh://builder@docker.example.test",
      useDockerConfig: false,
    },
    {
      name: "missing named context metadata",
      context: "missing-context",
      omitMetadata: true,
      useDockerConfig: true,
    },
    {
      name: "malformed named context metadata",
      context: "malformed-context",
      metadata: "{not-json",
      useDockerConfig: true,
    },
    {
      name: "named context without Docker endpoint",
      context: "missing-endpoint",
      metadata: {
        Name: "missing-endpoint",
        Metadata: {},
        Endpoints: {},
      },
      useDockerConfig: true,
    },
    {
      name: "relative Unix endpoint",
      context: "relative-unix",
      host: "unix://relative/docker.sock",
      useDockerConfig: true,
    },
    {
      name: "unsupported local-looking endpoint scheme",
      context: "unsupported-scheme",
      host: "fd://docker.sock",
      useDockerConfig: true,
    },
    {
      name: "inconsistent context metadata name",
      context: "expected-name",
      metadata: dockerContextMetadata(
        "different-name",
        "unix:///var/run/docker.sock",
      ),
      useDockerConfig: true,
    },
    {
      name: "typed-invalid Docker endpoint metadata",
      context: "typed-invalid-endpoint",
      metadata: {
        Name: "typed-invalid-endpoint",
        Metadata: {},
        Endpoints: {
          docker: {
            Host: "unix:///var/run/docker.sock",
            SkipTLSVerify: "false",
          },
        },
      },
      useDockerConfig: true,
    },
    {
      name: "typed-invalid Docker context metadata",
      context: "typed-invalid-context",
      metadata: {
        Name: "typed-invalid-context",
        Metadata: { Description: null },
        Endpoints: {
          docker: {
            Host: "unix:///var/run/docker.sock",
            SkipTLSVerify: false,
          },
        },
      },
      useDockerConfig: true,
    },
    {
      name: "duplicate metadata key hides an earlier typed error",
      context: "duplicate-metadata",
      metadata: `${JSON.stringify({
        Name: "duplicate-metadata",
        Metadata: {},
        Endpoints: [],
      }).slice(0, -1)},"Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock","SkipTLSVerify":false}}}`,
      useDockerConfig: true,
    },
    {
      name: "Go EqualFold long-s alias duplicates a valid typed field",
      context: "unicode-long-s",
      metadata:
        '{"Name":"unicode-long-s","Metadata":{},"Endpointſ":{"docker":{"Host":"unix:///var/run/docker.sock","SkipTLSVerify":false}},"Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock","SkipTLSVerify":false}}}',
      expectedError:
        /Docker context unicode-long-s contains duplicate typed field Endpoints/,
      useDockerConfig: true,
    },
    {
      name: "Go EqualFold Kelvin alias duplicates a valid typed field",
      context: "unicode-kelvin",
      metadata:
        '{"Name":"unicode-kelvin","Metadata":{},"Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock","SKipTLSVerify":false,"SkipTLSVerify":false}}}',
      expectedError:
        /Docker context unicode-kelvin contains duplicate typed field SkipTLSVerify/,
      useDockerConfig: true,
    },
  ];

  for (const contextCase of blocked) {
    await t.test(contextCase.name, async (t) => {
      const fixture = await makeFixture(t);
      await writeSafeAnalyticsConfig(fixture.root);
      const home = path.join(fixture.root, "home");
      const configRoot = contextCase.useDockerConfig
        ? path.join(fixture.root, "docker-config")
        : path.join(home, ".docker");
      await mkdir(configRoot, { recursive: true });
      await writeFile(
        path.join(configRoot, "config.json"),
        `${JSON.stringify({ currentContext: contextCase.context })}\n`,
      );
      if (!contextCase.omitMetadata) {
        const metadata =
          contextCase.metadata ??
          dockerContextMetadata(contextCase.context, contextCase.host);
        const metadataRoot = path.join(
          configRoot,
          "contexts",
          "meta",
          sha256(contextCase.context),
        );
        await mkdir(metadataRoot, { recursive: true });
        await writeFile(
          path.join(metadataRoot, "meta.json"),
          typeof metadata === "string"
            ? metadata
            : `${JSON.stringify(metadata)}\n`,
        );
      }
      let childSpawned = false;
      const processEnvironment = {
        HOME: home,
        ...(contextCase.useDockerConfig
          ? { DOCKER_CONFIG: configRoot }
          : {}),
      };

      await assert.rejects(
        runSupabase(["--version", "--workdir", fixture.root], {
          ...fixture.options,
          processEnvironment,
          invokeCli: async () => {
            childSpawned = true;
            return { status: 0 };
          },
        }),
        contextCase.expectedError ??
          /Docker (?:configuration|context|endpoint)/i,
      );
      assert.equal(childSpawned, false);
    });
  }

  const malformedConfigs = [
    ["invalid JSON", "{not-json"],
    [
      "typed-invalid auths",
      `${JSON.stringify({
        currentContext: "default",
        auths: [],
      })}\n`,
    ],
    [
      "duplicate key hides an earlier typed error",
      '{"currentContext":"default","auths":[],"auths":{}}\n',
    ],
    [
      "single Go EqualFold alias remains typed",
      '{"currentContext":"default","aliaseſ":[]}\n',
    ],
  ];
  for (const [name, contents] of malformedConfigs) {
    await t.test(`malformed Docker configuration: ${name}`, async (t) => {
      const malformedFixture = await makeFixture(t);
      await writeSafeAnalyticsConfig(malformedFixture.root);
      const malformedConfigRoot = path.join(
        malformedFixture.root,
        "malformed-docker-config",
      );
      await mkdir(malformedConfigRoot);
      await writeFile(
        path.join(malformedConfigRoot, "config.json"),
        contents,
      );
      let malformedChildSpawned = false;
      await assert.rejects(
        runSupabase(["--version", "--workdir", malformedFixture.root], {
          ...malformedFixture.options,
          processEnvironment: {
            HOME: path.join(malformedFixture.root, "home"),
            DOCKER_CONFIG: malformedConfigRoot,
          },
          invokeCli: async () => {
            malformedChildSpawned = true;
            return { status: 0 };
          },
        }),
        /Docker configuration/i,
      );
      assert.equal(malformedChildSpawned, false);
    });
  }

  const allowed = [
    {
      name: "default local Unix socket",
      expectedHost: "unix:///var/run/docker.sock",
      configure: async (fixture) => {
        const home = path.join(fixture.root, "home");
        await mkdir(path.join(home, ".docker"), { recursive: true });
        return { HOME: home };
      },
    },
    {
      name: "Docker Desktop-style local Unix context",
      expectedHost: "unix:///Users/test/.docker/run/docker.sock",
      configure: async (fixture) => {
        const home = path.join(fixture.root, "home");
        const configRoot = path.join(home, ".docker");
        const contextName = "desktop-linux";
        const metadata = dockerContextMetadata(
          contextName,
          "unix:///Users/test/.docker/run/docker.sock",
        );
        metadata.Metadata = {
          description: null,
          vendorExtension: { preserved: true },
        };
        await writeDockerContext(
          configRoot,
          contextName,
          metadata,
        );
        const dockerConfig = JSON.stringify({
            auths: {
              "registry.example.test": {
                auth: Buffer.from("user:password").toString("base64"),
                "paßword": { remainsUnknown: true },
              },
            },
            credsStore: "desktop",
            currentContext: contextName,
            plugins: {
              debug: { hooks: "exec" },
            },
            features: { hooks: "true" },
            vendorExtension: { firstUnknownValue: true },
          });
        await writeFile(
          path.join(configRoot, "config.json"),
          `${dockerConfig.slice(0, -1)},"vendorExtension":{"lastUnknownValue":true}}\n`,
        );
        return { HOME: home };
      },
    },
    {
      name: "Linux default local Unix socket",
      expectedHost: "unix:///var/run/docker.sock",
      configure: async (fixture) => {
        await configureFixturePlatform(fixture, "linux", "x64");
        const home = path.join(fixture.root, "home");
        await mkdir(path.join(home, ".docker"), { recursive: true });
        return { HOME: home };
      },
    },
    {
      name: "Go EqualFold aliases remain valid without duplicates",
      expectedHost: "unix:///var/run/docker.sock",
      configure: async (fixture) => {
        const home = path.join(fixture.root, "home");
        const contextName = "unicode-simple-fold";
        await writeDockerContext(
          path.join(home, ".docker"),
          contextName,
          {
            Name: contextName,
            Metadata: {},
            "Endpointſ": {
              docker: {
                Host: "unix:///var/run/docker.sock",
                "SKipTLSVerify": false,
              },
            },
          },
        );
        return { HOME: home };
      },
    },
  ];

  for (const contextCase of allowed) {
    await t.test(contextCase.name, async (t) => {
      const fixture = await makeFixture(t);
      await writeSafeAnalyticsConfig(fixture.root);
      const processEnvironment = await contextCase.configure(fixture);
      const calls = [];

      await runSupabase(["--version", "--workdir", fixture.root], {
        ...fixture.options,
        processEnvironment,
        invokeCli: async (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0 };
        },
      });

      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].options.env.DOCKER_HOST,
        contextCase.expectedHost,
      );
      assert.equal(calls[0].options.env.DOCKER_CONTEXT, "default");
      assert.equal(
        calls[0].options.env.DOCKER_CONFIG,
        path.resolve(
          processEnvironment.DOCKER_CONFIG ??
            path.join(processEnvironment.HOME, ".docker"),
        ),
      );
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
    processEnvironment: await defaultDockerEnvironment(fixture),
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

test("every wrapper command rejects unsafe effective Analytics config before child spawn", async (t) => {
  const commands = [
    ["start"],
    ["test", "db", "--local"],
    ["stop", "--no-backup"],
    ["--version"],
  ];
  const configs = [
    ["missing analytics block", "[api]\nport = 54321\n"],
    ["analytics enabled", "[analytics]\nenabled = true\n"],
    ["malformed analytics flag", '[analytics]\nenabled = "false"\n'],
    [
      "duplicate analytics blocks",
      "[analytics]\nenabled = false\n[analytics]\nenabled = false\n",
    ],
  ];

  for (const args of commands) {
    for (const [configName, config] of configs) {
      await t.test(`${args.join(" ")}: ${configName}`, async (t) => {
        const fixture = await makeFixture(t);
        const supabaseRoot = path.join(fixture.root, "supabase");
        await mkdir(supabaseRoot);
        await writeFile(path.join(supabaseRoot, "config.toml"), config);
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
          /analytics/i,
        );
        assert.equal(childSpawned, false);
      });
    }
  }
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
