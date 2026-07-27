# Docker CLI v28.5.2 context safety

## Scope and conclusion

This note traces the exact Docker endpoint selected by the pinned
`github.com/docker/cli` v28.5.2 code used by Supabase CLI v2.105.0. It does not
describe newer Docker releases.

The reported path is real. Supabase constructs `command.NewDockerCli()`,
initializes it with an empty `ClientOptions`, and immediately calls `Client()`.
That call resolves the current Docker context and pings its endpoint during
package initialization, before the requested Supabase command runs. A valid
`currentContext` in Docker configuration can therefore select a TCP or SSH
daemon even when the caller did not set `DOCKER_HOST` or `DOCKER_CONTEXT`.
([Supabase v2.105.0 `internal/utils/docker.go`](https://github.com/supabase/cli/blob/b749d52b8e86813dfbcef4b34d0f038b78695131/apps/cli-go/internal/utils/docker.go#L41-L56),
[Docker CLI client initialization](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L550-L568))

A bounded wrapper correction is truthful without a Docker CLI fork:

1. Resolve the effective context once, before child spawn, using the pinned
   lookup rules below.
2. Fail closed unless the resolved endpoint is an absolute `unix://` socket
   path on Darwin or Linux.
3. Put that normalized endpoint into the child's `DOCKER_HOST`, put the child
   on the controlled `default` context, and pin `DOCKER_CONFIG` to the absolute
   directory that was inspected.

For v28.5.2, a nonempty `DOCKER_HOST` forces the virtual `default` context, so
later replacement of `config.json` or named-context metadata cannot redirect
the child to another endpoint. The Docker configuration may still supply
non-endpoint settings; it no longer has endpoint-selection authority.
([context precedence](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L455-L479),
[default endpoint resolution](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L356-L385))

## Exact selection semantics

`NewDockerCli()` installs the standard typed context-store configuration.
`Initialize()` then applies a nonempty `ClientOptions.ConfigDir`, loads
`config.json`, resolves a context name, and creates the context store under the
effective Docker configuration directory.
([constructor](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L600-L618),
[`Initialize`](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L228-L277))

The pinned implementation resolves the context name in this order:

1. `ClientOptions.Context` (`--context`);
2. `ClientOptions.Hosts` (`--host`) selects the virtual `default` context;
3. nonempty `DOCKER_HOST` selects the virtual `default` context;
4. nonempty `DOCKER_CONTEXT`;
5. nonempty `currentContext` from `config.json`;
6. the virtual `default` context.

Supplying both context and host options is rejected. Supabase passes an empty
`ClientOptions`, so only steps 3–6 apply. In particular, after the wrapper
rejects caller `DOCKER_HOST` and `DOCKER_CONTEXT`, `currentContext` remains
authoritative.
([conflict check and initialization](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L238-L271),
[`resolveContextName`](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L455-L479))

The effective configuration directory is:

1. nonempty `ClientOptions.ConfigDir`;
2. otherwise nonempty `DOCKER_CONFIG`;
3. otherwise the current user's home directory plus `.docker`.

Supabase supplies no `ConfigDir`, so inherited `DOCKER_CONFIG` wins; absent
that, the default is `~/.docker/config.json`. A relative `DOCKER_CONFIG` remains
relative to the child process working directory, so a wrapper must resolve it
against the same working directory before inspecting it and pass the resulting
absolute directory to the child.
([configuration-directory resolution](https://github.com/docker/cli/blob/v28.5.2/cli/config/config.go#L19-L30),
[`config.Dir`](https://github.com/docker/cli/blob/v28.5.2/cli/config/config.go#L46-L90),
[official configuration precedence](https://github.com/docker/cli/blob/v28.5.2/docs/reference/commandline/docker.md#docker-cli-configuration-file-configjson-properties))

The generated documentation says `DOCKER_CONTEXT` overrides `DOCKER_HOST`, but
the exact v28.5.2 implementation checked above tests `DOCKER_HOST` first. The
source implementation is the compatibility target for this pinned internal API.
([environment-variable table](https://github.com/docker/cli/blob/v28.5.2/docs/reference/commandline/docker.md#environment-variables),
[`resolveContextName`](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L461-L478))

## Context storage and endpoint parsing

`config.json` carries `currentContext`. Named contexts are stored under:

```text
<config-dir>/contexts/meta/<sha256(context-name)>/meta.json
<config-dir>/contexts/tls/<sha256(context-name)>/...
```

The directory identifier is the lowercase hex SHA-256 digest of the context
name. The metadata JSON contains `Name`, `Metadata`, and `Endpoints`; the
`docker` endpoint has `Host` and `SkipTLSVerify`.
([config-file shape](https://github.com/docker/cli/blob/v28.5.2/cli/config/configfile/file.go#L19-L49),
[context-store roots](https://github.com/docker/cli/blob/v28.5.2/cli/context/store/store.go#L97-L111),
[context hash](https://github.com/docker/cli/blob/v28.5.2/cli/context/store/store.go#L503-L507),
[metadata reader](https://github.com/docker/cli/blob/v28.5.2/cli/context/store/metadatastore.go#L63-L96))

For a named context, `Client()` loads that metadata, requires a typed `docker`
endpoint, loads any TLS files, and constructs the API client. TCP endpoints are
used directly; SSH endpoints use the Docker SSH connection helper. Both can
reach a remote daemon. Unix endpoints use a local socket transport.
([endpoint resolution](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L341-L353),
[`Endpoint.ClientOpts`](https://github.com/docker/cli/blob/v28.5.2/cli/context/docker/load.go#L85-L137),
[official endpoint protocols](https://github.com/docker/cli/blob/v28.5.2/docs/reference/commandline/docker.md#specify-daemon-host--h---host))

On both supported platforms, the virtual `default` context resolves to
`unix:///var/run/docker.sock` when no host override is present. A Docker
Desktop-style named context is compatible with the bounded design when its
stored host is another absolute local Unix endpoint such as
`unix:///absolute/path/to/docker.sock`; it is the transport scheme and absolute
socket path, not the context name, that establishes the local-only property.
([non-Windows default host](https://github.com/moby/moby/blob/v28.5.2/client/client_unix.go#L1-L14),
[official macOS/Linux default](https://github.com/docker/cli/blob/v28.5.2/docs/reference/commandline/docker.md#specify-daemon-host--h---host))

The wrapper should accept only a host that:

- has exactly the `unix` scheme;
- has a nonempty absolute path;
- has no user information, remote authority, query, or fragment; and
- round-trips to one normalized `unix://` endpoint.

It should reject `tcp`, `ssh`, `http`, `https`, `fd`, `npipe`, an empty host,
relative Unix paths, and unknown schemes. `npipe` is not part of the committed
Darwin/Linux artifact contract.

## Missing and malformed inputs

Pinned Docker CLI behavior is not itself fail closed:

- A missing `config.json` becomes an empty configuration and therefore selects
  the virtual `default` context.
- An unreadable or malformed `config.json` prints a warning and returns a
  default/partially decoded config object instead of returning the error.
- `Initialize()` records a named current context without proving that it exists
  or is valid.
- Missing or malformed named-context metadata is detected only when `Client()`
  lazily resolves the endpoint, after the wrapper has spawned the Supabase
  child.

([config loading](https://github.com/docker/cli/blob/v28.5.2/cli/config/config.go#L119-L176),
[deferred context validation](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L424-L450),
[`Client()` and lazy initialization](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L107-L113))

The SnapList wrapper's stricter result should be:

| Input | Result before child spawn |
| --- | --- |
| No `config.json`, or no/empty/`default` `currentContext` | Resolve the pinned Darwin/Linux default Unix endpoint and allow it |
| Well-formed named context with an absolute Unix endpoint | Normalize, pin, and allow it |
| Named context with TCP or SSH endpoint | Reject |
| Named context whose metadata is absent | Reject |
| Unreadable/malformed config or metadata | Reject |
| Missing, empty, relative, or otherwise unprovable endpoint | Reject |
| Metadata whose stored `Name` does not match the selected context | Reject as inconsistent |

Strict rejection of malformed configuration is an intentional fail-closed
strengthening over Docker CLI v28.5.2, while the selection precedence and valid
endpoint result remain compatible.

The wrapper mirrors the bounded typed JSON surface used by the pinned
`ConfigFile`, `DockerContext`, and Docker `EndpointMeta` decoders before using
any selection field. That includes the string, string-map, string-slice, auth,
proxy, and plugin shapes in `config.json`; the typed context description; and
the Docker endpoint's string `Host` and boolean `SkipTLSVerify`. Unknown
configuration keys remain compatible because Go's decoder ignores them.
Realistic registry, credential-store, plugin, and feature settings therefore
remain valid, while a known field with the wrong JSON type fails before child
spawn. Named-context metadata uses the same rule for both its typed context
metadata and every endpoint object. The JSON scan retains typed-field duplicate
visibility before `JSON.parse` can collapse earlier values; duplicates of
unknown extensions keep the pinned last-value behavior. Docker's custom
`DockerContext` decoder treats only exact-case `Description` as typed, so
case-varied extension keys remain opaque and compatible.

For the other typed struct fields, pinned Go `encoding/json` uses
Unicode-simple-fold equality rather than JavaScript casing. Because every
known field name here is ASCII, the wrapper uses a narrow matcher for ASCII
case plus the two pinned simple-fold orbits that reach ASCII: long s (`ſ`) to
`S`/`s` and Kelvin sign (`K`) to `K`/`k`. It does not apply multi-character
full-case expansions: for example, `paßword` remains an unknown extension and
does not become `password`. The duplicate scanner and semantic validators use
the same matcher so their typed identities cannot diverge.
([Go 1.25.5 JSON field folding](https://github.com/golang/go/blob/go1.25.5/src/encoding/json/fold.go),
[Go 1.25.5 simple-fold table](https://github.com/golang/go/blob/go1.25.5/src/unicode/tables.go#L9345-L9431))

## TOCTOU model and mitigation

Validation followed by an unchanged inherited environment is insufficient.
`config.json` chooses a context, while a second file supplies the endpoint, and
the child rereads both after spawn. Either file can be replaced between wrapper
validation and `Client()`; `Client()` also issues an initial `Ping` to the
selected endpoint.
([separate config and context reads](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L269-L277),
[lazy endpoint initialization and ping](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L395-L417))

The minimal race-safe seam is value pinning, not a second timing check:

1. Read and strictly parse one config snapshot.
2. If named, read and strictly parse the selected metadata snapshot.
3. Classify and normalize the resulting Unix endpoint.
4. Spawn with controlled `DOCKER_HOST=<normalized-unix-endpoint>`,
   `DOCKER_CONTEXT=default`, and an absolute `DOCKER_CONFIG`.

With pinned v28.5.2 precedence, the child no longer consults
`currentContext` or named-context metadata to select its endpoint. Replacing
those files after validation cannot convert the pinned Unix transport into TCP
or SSH. This preserves ordinary Docker configuration for credentials and other
non-endpoint behavior without claiming that those unrelated bytes are
immutable.

Required public no-spawn cases are TCP and SSH contexts selected only through
default-HOME configuration and through inherited `DOCKER_CONFIG`, plus malformed
config (including a wrong typed field), missing metadata, malformed or
inconsistently named metadata, a wrong typed Docker endpoint, missing endpoint,
and unsupported scheme. Positive controls are the Darwin and Linux virtual
default Unix socket and a named Docker Desktop-style absolute Unix endpoint
alongside realistic Docker configuration fields. Tests must assert that the
child receives only the normalized controlled endpoint/context values, the
exact inspected configuration root, and not the caller's endpoint selectors.
