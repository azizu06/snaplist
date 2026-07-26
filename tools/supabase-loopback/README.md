# Local Supabase loopback wrapper

Project-owned Supabase commands must run through `pnpm supabase`. The wrapper
fails before invoking either Supabase CLI layer unless the installed CLI, exact
official `supabase-go` source identity, patch, generated build receipt,
platform package, platform CLI, and patched binary match `manifest.json` and
the wrapper's compiled-in contract.

Prepare and test the ignored local artifact without starting Supabase or
touching Docker:

```sh
pnpm prepare:supabase-loopback -- --source-only
pnpm test:supabase-loopback -- --source-only
```

The pinned CLI's internal override is
`apps/cli/src/shared/legacy/go-proxy.layer.ts`. In tag `v2.105.0`,
`SUPABASE_GO_BINARY` is the first binary-resolution branch. The same module
creates the Go child with `env: opts?.env` and `extendEnv: true`, so the
validated path inherited by the platform CLI reaches its Go child.

The wrapper also pins the base npm shim and platform CLI digests and supplies
`SUPABASE_CLI_BINARY_OVERRIDE` itself. Caller-provided overrides are rejected.
If Supabase changes or removes either override seam, the pinned source or CLI
digest check fails before CLI execution; there is no stock-binary fallback.

Before `start`, the wrapper parses the effective workdir's
`supabase/config.toml` and requires exactly one `[analytics]` block with the
boolean literal `enabled = false`. Missing, enabled, or malformed Analytics
configuration and caller-provided host networking fail before child spawn.
Disabling Analytics removes both Vector and Logflare, so local analytics port
`54327` is intentionally absent.

The exact-tag Go patch also rejects Docker socket binds/mounts, container
`DOCKER_HOST`, privileged mode, host networking, devices/device requests, and
`PublishAllPorts`. That guard runs after effective network selection but before
image inspection or pull, network/volume creation, or container creation.

The generated source checkout, binary, and build receipt live under `.cache/`
and are intentionally ignored. The executable is never committed.
