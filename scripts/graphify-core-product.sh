#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scope_file="$repo_root/docs/architecture/graphify-core-scope.txt"
generated_scope="$(mktemp)"
corpus_root=""

cleanup() {
  rm -f "$generated_scope"
  if [[ "${1:-}" != "keep" && -n "$corpus_root" && -d "$corpus_root" ]]; then
    rm -rf "$corpus_root"
  fi
}
trap cleanup EXIT

cd "$repo_root"

git ls-files \
  | rg '^(\.env\.example|AGENTS\.md|CONTEXT\.md|PRD\.md|Dockerfile(\.mobile-runtime-proof)?|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|next\.config\.(ts|js)|vitest\.config\.(ts|js)|eslint\.config\.(js|mjs)|vercel\.json|docs/(adr/|agents/|contracts/|design/native-v1-)|ios/(DesignContracts/V1/(README-FIRST\.md|mobile-api-v1\.openapi\.json|snaplist-swiftui-mapping-notes\.md)|SnapList/.*\.swift$|SnapList\.xcodeproj/project\.pbxproj$)|src/(instrumentation\.ts$|lib/|app/\(app\)/.*actions\.ts$|app/api/|app/v1/|app/webhooks/|runtime/|proxy\.ts$)|supabase/(migrations/|functions/|config\.toml$)|evals/(README|run|schema|metrics))' \
  | rg -v '(^|/)(__snapshots__|node_modules|\.next|DerivedData|fixtures?|testdata|goldens?)(/|$)|Fixtures?\.swift$|fixtures?\.(ts|tsx)$|demo-products\.ts$|\.(test|spec)\.(ts|tsx|swift)$|/Tests?/|UITests|\.xcresult|\.(png|jpe?g|gif|mp4|mov|webm|pdf)$' \
  > "$generated_scope"

if ! cmp -s "$scope_file" "$generated_scope"; then
  echo "Core Graphify scope is stale. Review this diff and update the committed manifest:" >&2
  diff -u "$scope_file" "$generated_scope" >&2 || true
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Core Graphify generation requires a clean tracked worktree and index." >&2
  exit 1
fi

source_commit="$(git rev-parse HEAD)"
corpus_root="$(mktemp -d "${TMPDIR:-/tmp}/snaplist-graphify-core.XXXXXX")"
scope_paths=()
while IFS= read -r scope_path; do
  scope_paths+=("$scope_path")
done < "$scope_file"
git archive "$source_commit" -- "${scope_paths[@]}" | tar -x -C "$corpus_root"

if [[ "${1:-}" == "--prepare-only" ]]; then
  echo "SOURCE_COMMIT=$source_commit"
  echo "SOURCE_FILES=${#scope_paths[@]}"
  echo "CORPUS_PATH=$corpus_root"
  trap 'cleanup keep' EXIT
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  echo "Usage: scripts/graphify-core-product.sh [--prepare-only]" >&2
  exit 2
fi

graphify_python="${GRAPHIFY_PYTHON:-$HOME/.local/share/uv/tools/graphifyy/bin/python}"
if [[ ! -x "$graphify_python" ]]; then
  echo "Graphify Python was not found at $graphify_python" >&2
  exit 1
fi

"$graphify_python" "$repo_root/scripts/graphify-core-product.py" \
  --corpus "$corpus_root" \
  --repo "$repo_root" \
  --scope "$scope_file" \
  --source-commit "$source_commit"

echo "SOURCE_COMMIT=$source_commit"
echo "SOURCE_FILES=${#scope_paths[@]}"
echo "GRAPH_PATH=$repo_root/graphify-out/graph.json"
