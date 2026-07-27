# Host-bind safety design

## Decision

The patched `supabase-go` client does not treat a raw path string or
`filepath.EvalSymlinks` result as a security boundary. Before a Docker request,
the central isolation seam parses each bind by mount type and prepares only
these host-backed sources:

- an existing regular file;
- an existing directory; or
- a Docker named volume, which has no host-path traversal.

Unix sockets, named pipes, devices, irregular files, malformed mounts, and
container-runtime endpoint names remain fail-closed. Bind destinations are
also checked after mount parsing. A source with symlink components is resolved
to an absolute canonical path, every resolved component and the final file
type are checked, and the Docker request is rewritten to that canonical source.
Each source remains open so its identity can be compared again after image
resolution and immediately before `ContainerCreate`.

On Darwin and Linux, every path component must be owned by root or the current
effective user. A component writable by group/other is rejected unless it is a
sticky ancestor whose next child is root/current-user owned; a final bound
directory is never allowed to be group/other writable. These constraints
prevent another OS user from replacing the canonical path between checks.

The only project-owned path that binds an arbitrary caller-selected file is
`db start --from-backup`. The public command opens and pins an ordinary regular
backup before its running-container inspection, then copies once from that held
handle into a newly created owner-only staging directory and binds the staged
file. The staging path is removed when database startup returns; a removal
failure is returned to the caller instead of being hidden. Docker therefore
never consumes the caller-controlled symlink or its original pathname.

## TOCTOU boundary

Canonical rewriting prevents retargeting the original symlink between
validation and daemon consumption. Private staging additionally removes the
caller-controlled backup inode and parent directory from that interval.
Ownership/mode restrictions exclude replacement by a different OS user.
Central identity revalidation catches other replacement at the post-image and
pre-create checkpoints.

The supported threat model excludes a process already running as the same OS
user deliberately replacing the prepared canonical or private staged path:
that principal can already invoke the user's Docker endpoint directly. No
claim is made that `EvalSymlinks` pins an inode across a client/daemon boundary.
Preventing a same-user replacement race portably would require daemon-side
descriptor/handle retention rather than a path-string API.

## Cross-platform behavior

Darwin and Linux are the committed artifact platforms. Both accept only trusted
existing regular-file/directory host sources and named volumes. Other platforms
fail closed for host-backed sources. Windows Docker Engine named-pipe mounts
remain rejected by parsed mount type and exact endpoint classification; no
Windows artifact is published by this contract. Path normalization follows the
build platform, while slash and case normalization is retained for endpoint
names.

Ordinary regular-file and directory binds and named volumes remain positive
controls. Symlinks resolving to Docker, containerd, Podman, CRI-O, or Windows
Docker Engine endpoint families fail before image inspection/pull, network or
volume inspection/creation, container creation, or any other Docker request.

## Pinned-source findings

- Moby v28.5.2 parses ordinary binds but returns their source path to mount
  setup; it does not generally canonicalize them:
  [mount parsing](https://github.com/moby/moby/blob/v28.5.2/volume/mounts/linux_parser.go)
  and
  [mount setup](https://github.com/moby/moby/blob/v28.5.2/volume/mounts/mounts.go).
- Moby's stronger safe-path implementation retains file descriptors on Linux
  and component handles on Windows. That mechanism is daemon-side and is used
  for subpaths, not arbitrary client bind strings:
  [safe-path package](https://github.com/moby/moby/tree/v28.5.2/internal/safepath).
- Go's `filepath.EvalSymlinks` only returns a resolved path. It does not retain
  the resolved object:
  [`filepath.EvalSymlinks`](https://pkg.go.dev/path/filepath#EvalSymlinks).

This is a truthful minimal GREEN because Docker receives a canonical source
whose component permissions exclude untrusted replacement, its held identity
is rechecked before creation, and the externally selected backup file is staged
from an already-open handle. It deliberately does not claim to solve a
same-user/root client/daemon race that the Docker path-string API cannot pin.
