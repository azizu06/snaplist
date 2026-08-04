# Core-product Graphify snapshot

This snapshot maps SnapList's current product architecture without indexing the
large presentation and media surfaces that obscured the earlier July 1 graph.

## Reproducible corpus

The exact tracked input list is committed in
`docs/architecture/graphify-core-scope.txt`. Prepare a clean temporary corpus:

```bash
scripts/graphify-core-product.sh
```

The script fails if the repository's current tracked files no longer match the
committed scope. Review that diff before updating the manifest. This makes a
scope change an explicit architecture decision rather than an accidental graph
expansion.

Included categories:

- native SwiftUI app, feature, navigation, API, subscription, and design-system code;
- core server/domain TypeScript, server actions, and API/runtime entry points;
- Supabase migrations, functions, and local configuration;
- mobile OpenAPI and current native architecture/design handoff documents;
- ADRs, PRD, context, agent workflow, deployment/runtime files, and root build configuration.

Excluded categories:

- public media and demo catalog presentation assets;
- marketing-only page/component code;
- unit/UI tests, fixtures, screenshots, videos, PDFs, and golden artifacts;
- dependencies, build output, prior Graphify output, and other generated files.

## Generation

Run the source-pinned generator from a clean tracked worktree:

```bash
scripts/graphify-core-product.sh
```

The script archives the committed scope directly from `HEAD`, then writes the
result to the repository-local ignored `graphify-out/` directory. It never reads
modified tracked working-tree content into a graph labeled as the unchanged
commit. `--prepare-only` emits the exact temporary corpus for inspection without
generating output.

Graphify's SQL parser is required so migrations contribute tables, functions,
RLS, and RPC relationships. Install the pinned optional parser when necessary:

```bash
uv pip install --python ~/.local/share/uv/tools/graphifyy/bin/python tree-sitter-sql==0.3.11
```

One source filename is a known sensitive-name false positive. The generator
adds that audited code file only to local AST extraction. It is never sent to a
semantic provider. `.env.example` is represented by path and Git blob only; its
contents stay behind Graphify's sensitive-content boundary.

The generated graph is an operator artifact and stays ignored because its HTML,
JSON, caches, and semantic extraction intermediates are large and reproducible.
This document, the exact scope manifest, and the preparation script are the
versioned contract.

## Current snapshot

- Graphify: `graphifyy v0.8.33`
- Tracked and represented scope: 321 files
- Graph: 4,390 nodes and 8,702 edges. The generated report records the exact
  deterministic-clustering community count for each run.
- Generation command: `scripts/graphify-core-product.sh`

The snapshot uses deterministic Graphify AST extraction plus document-heading
nodes. It consumes no semantic-model tokens. The graph and report use
repository-relative source paths so the ignored artifact remains navigable
after the temporary corpus is removed. Re-run the same script after a core scope
or code change; do not run `graphify update .`, which would bypass the committed
scope and index excluded presentation surfaces.
