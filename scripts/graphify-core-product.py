#!/usr/bin/env python3
"""Build SnapList's deterministic core-product Graphify artifact."""

from __future__ import annotations

import argparse
import collections
import contextlib
import io
import importlib.metadata
import json
import re
import hashlib
import subprocess
import sys
from pathlib import Path

from graphify.analyze import god_nodes, suggest_questions, surprising_connections
from graphify.build import build_from_json
from graphify.benchmark import print_benchmark, run_benchmark
from graphify.cluster import cluster, score_all
from graphify.detect import detect
from graphify.export import to_html, to_json
from graphify.extract import extract
from graphify.report import generate


SAFE_LOCAL_AST_OVERRIDES = ("src/lib/marketplace/ebay/user-token-provider.ts",)
SENSITIVE_CONTENT_EXCLUSIONS = (".env.example",)
STATE_VERSION = 1
GRAPHIFY_VERSION = "0.8.33"
SQL_PARSER_VERSION = "0.3.11"
STATE_FILE = "core-product-state.json"
RECEIPT_FILE = "core-product-receipt.json"
REQUIRED_LABEL_FRAGMENTS = {
    "reserve_ai_item_credit_for_pipeline_run",
    "pipeline_runs",
    "UserTokenProvider",
}


def scope_digest(scope: list[str]) -> str:
    return hashlib.sha256("\n".join(scope).encode("utf-8")).hexdigest()


def tool_versions() -> dict[str, str | None]:
    try:
        sql_parser_version = importlib.metadata.version("tree-sitter-sql")
    except importlib.metadata.PackageNotFoundError:
        sql_parser_version = None
    return {"graphifyy": importlib.metadata.version("graphifyy"), "tree-sitter-sql": sql_parser_version}


def require_pinned_tools() -> dict[str, str | None]:
    versions = tool_versions()
    if versions["graphifyy"] != GRAPHIFY_VERSION:
        raise SystemExit(f"Graphify v{GRAPHIFY_VERSION} is required for this snapshot")
    if versions["tree-sitter-sql"] != SQL_PARSER_VERSION:
        raise SystemExit(
            "Install the Graphify SQL extra: uv pip install --python "
            "~/.local/share/uv/tools/graphifyy/bin/python tree-sitter-sql==0.3.11"
        )
    return versions


def load_compatible_state(
    output: Path, repo: Path, scope: list[str], versions: dict[str, str | None]
) -> tuple[dict | None, str | None]:
    state_path = output / STATE_FILE
    graph_path = output / "graph.json"
    if not state_path.exists() or not graph_path.exists():
        return None, "no prior graph/cache"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, "no compatible prior graph/cache"
    if state.get("state_version") != STATE_VERSION:
        return None, "no compatible prior graph/cache"
    if state.get("scope_digest") != scope_digest(scope):
        return None, "committed scope changed"
    if state.get("tool_versions") != versions:
        return None, "Graphify/parser version changed"
    if not isinstance(state.get("extraction"), dict) or not isinstance(state.get("source_commit"), str):
        return None, "no compatible prior graph/cache"
    if subprocess.run(
        ["git", "-C", str(repo), "cat-file", "-e", f"{state['source_commit']}^{{commit}}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode != 0:
        return None, "no compatible prior graph/cache"
    return state, None


def changed_scope_paths(repo: Path, previous_commit: str, source_commit: str, scope: set[str]) -> set[str]:
    output = subprocess.check_output(
        ["git", "-C", str(repo), "diff", "--name-only", previous_commit, source_commit, "--"],
        text=True,
    )
    return {path for path in output.splitlines() if path in scope}


def remove_sources(extraction: dict, sources: set[str]) -> dict:
    nodes = [node for node in extraction.get("nodes", []) if node.get("source_file") not in sources]
    edges = [
        edge
        for edge in extraction.get("edges", [])
        if edge.get("source_file") not in sources
    ]
    return {"nodes": nodes, "edges": edges, "hyperedges": []}


def merge_incremental_extraction(previous: dict, changed: dict, changed_sources: set[str]) -> dict:
    """Replace changed sources while retaining valid unchanged inbound edges."""
    removed_node_ids = {
        node.get("id")
        for node in previous.get("nodes", [])
        if node.get("source_file") in changed_sources
    }
    preserved = remove_sources(previous, changed_sources)
    replacement_ids = {node.get("id") for node in changed.get("nodes", [])}
    preserved["edges"] = [
        edge
        for edge in preserved["edges"]
        if (edge.get("source") not in removed_node_ids or edge.get("source") in replacement_ids)
        and (edge.get("target") not in removed_node_ids or edge.get("target") in replacement_ids)
    ]
    merged = {
        "nodes": [*preserved["nodes"], *changed.get("nodes", [])],
        "edges": [*preserved["edges"], *changed.get("edges", [])],
        "hyperedges": [],
    }
    return normalize_extraction(merged, Path("."))


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def relative_source(value: object, corpus: Path) -> object:
    if not isinstance(value, str):
        return value
    try:
        return Path(value).resolve().relative_to(corpus).as_posix()
    except (OSError, ValueError):
        return value


def normalize_extraction(result: dict, corpus: Path) -> dict:
    id_map: dict[str, str] = {}
    for node in result.get("nodes", []):
        source = node.get("source_file")
        relative = relative_source(source, corpus)
        if source != relative and node.get("id") == slug(str(source)):
            id_map[node["id"]] = f"file_{slug(str(relative))}"

    nodes: list[dict] = []
    seen_nodes: set[str] = set()
    for original in result.get("nodes", []):
        node = dict(original)
        node["id"] = id_map.get(node.get("id"), node.get("id"))
        node["source_file"] = relative_source(node.get("source_file"), corpus)
        if node.get("id") not in seen_nodes:
            nodes.append(node)
            seen_nodes.add(node["id"])

    edges: list[dict] = []
    seen_edges: set[tuple] = set()
    for original in result.get("edges", []):
        edge = dict(original)
        edge["source"] = id_map.get(edge.get("source"), edge.get("source"))
        edge["target"] = id_map.get(edge.get("target"), edge.get("target"))
        edge["source_file"] = relative_source(edge.get("source_file"), corpus)
        key = (
            edge.get("source"),
            edge.get("target"),
            edge.get("relation"),
            edge.get("source_file"),
            edge.get("source_location"),
        )
        if key not in seen_edges:
            edges.append(edge)
            seen_edges.add(key)
    return {"nodes": nodes, "edges": edges, "hyperedges": []}


def add_scope_nodes(
    extraction: dict,
    scope: list[str],
    corpus: Path,
    source_paths: set[str] | None = None,
) -> None:
    node_ids = {node["id"] for node in extraction["nodes"]}
    project_id = "snaplist_core_product"
    if project_id not in node_ids:
        extraction["nodes"].append(
            {
                "id": project_id,
                "label": "SnapList Core Product",
                "file_type": "project",
                "source_file": "PRD.md",
                "source_location": "L1",
            }
        )
        node_ids.add(project_id)

    source_nodes: dict[str, list[str]] = collections.defaultdict(list)
    for node in extraction["nodes"]:
        source = node.get("source_file")
        if source:
            source_nodes[source].append(node["id"])

    edge_keys = {
        (edge.get("source"), edge.get("target"), edge.get("relation"))
        for edge in extraction["edges"]
    }
    for relative in scope:
        if source_paths is not None and relative not in source_paths:
            continue
        file_id = f"file_{slug(relative)}"
        if file_id not in node_ids:
            label = Path(relative).name
            if relative in SENSITIVE_CONTENT_EXCLUSIONS:
                label += " (content intentionally excluded)"
            extraction["nodes"].append(
                {
                    "id": file_id,
                    "label": label,
                    "file_type": "document" if relative.endswith(".md") else "code",
                    "source_file": relative,
                    "source_location": "L1",
                }
            )
            node_ids.add(file_id)
        relation = (project_id, file_id, "contains")
        if relation not in edge_keys:
            extraction["edges"].append(
                {
                    "source": project_id,
                    "target": file_id,
                    "relation": "contains",
                    "confidence": "EXTRACTED",
                    "source_file": relative,
                    "source_location": "L1",
                }
            )
            edge_keys.add(relation)

        if relative.endswith(".md") and relative not in SENSITIVE_CONTENT_EXCLUSIONS:
            text = (corpus / relative).read_text(encoding="utf-8", errors="replace")
            for line_number, line in enumerate(text.splitlines(), 1):
                match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
                if not match:
                    continue
                heading = re.sub(r"\s+#+$", "", match.group(2)).strip()
                heading_id = f"{file_id}_heading_{line_number}"
                extraction["nodes"].append(
                    {
                        "id": heading_id,
                        "label": heading,
                        "file_type": "concept",
                        "source_file": relative,
                        "source_location": f"L{line_number}",
                    }
                )
                extraction["edges"].append(
                    {
                        "source": file_id,
                        "target": heading_id,
                        "relation": "contains",
                        "confidence": "EXTRACTED",
                        "source_file": relative,
                        "source_location": f"L{line_number}",
                    }
                )


def label_words(value: str) -> list[str]:
    value = re.sub(r"\.[^.]+$", "", value)
    value = re.sub(r"[-_]+", " ", value)
    value = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", value)
    ignored = {"src", "lib", "index", "route", "swift", "ts", "tsx", "sql", "json", "md"}
    return [word.capitalize() for word in re.findall(r"[A-Za-z0-9]+", value) if word.lower() not in ignored]


def community_labels(communities: dict[int, list[str]], nodes: dict[str, dict]) -> dict[int, str]:
    raw: dict[int, str] = {}
    for community_id, members in communities.items():
        files = [nodes.get(member, {}).get("source_file", "") for member in members]
        files = [source for source in files if source]
        top = collections.Counter(files).most_common(1)[0][0] if files else "Architecture"
        parts = top.split("/")
        if top.startswith("ios/SnapList/Features/") and len(parts) > 3:
            words = ["iOS", parts[3], *label_words(parts[-1])[:2]]
        elif top.startswith("ios/SnapList/"):
            words = ["iOS", *label_words(parts[-1])[:3]]
        elif top.startswith("src/lib/") and len(parts) > 2:
            words = [*label_words(parts[2]), *label_words(parts[-1])[:2]]
        elif top.startswith("src/app/"):
            words = ["Server", "API", *label_words(parts[-2])[:2]]
        elif top.startswith("supabase/migrations/"):
            words = ["Database", *label_words(parts[-1])[-3:]]
        elif top.startswith("docs/adr/"):
            words = ["Architecture", *label_words(parts[-1])[1:4]]
        else:
            words = label_words(parts[-1])[:4]
        deduped: list[str] = []
        for word in words:
            if word and (not deduped or word.casefold() != deduped[-1].casefold()):
                deduped.append(word)
        if len(deduped) < 2:
            deduped.append("Architecture")
        raw[community_id] = " ".join(deduped[:5])

    totals = collections.Counter(raw.values())
    seen: collections.Counter[str] = collections.Counter()
    labels: dict[int, str] = {}
    for community_id in sorted(raw):
        label = raw[community_id]
        if totals[label] > 1:
            seen[label] += 1
            label = f"{label} {seen[label]}"
        labels[community_id] = label
    return labels


def write_state(
    output: Path,
    extraction: dict,
    source_commit: str,
    scope: list[str],
    versions: dict[str, str | None],
) -> None:
    (output / STATE_FILE).write_text(
        json.dumps(
            {
                "state_version": STATE_VERSION,
                "source_commit": source_commit,
                "scope_digest": scope_digest(scope),
                "tool_versions": versions,
                "extraction": extraction,
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )


def write_receipt(
    output: Path,
    source_commit: str,
    scope: list[str],
    changed_files: int,
    graph: object,
    run_mode: str,
    fallback_reason: str | None,
) -> None:
    receipt = {
        "source_sha": source_commit,
        "scoped_file_count": len(scope),
        "changed_file_count": changed_files,
        "node_count": graph.number_of_nodes(),
        "edge_count": graph.number_of_edges(),
        "run_mode": run_mode,
        "semantic_tokens": 0,
        "method": "deterministic AST and document-heading extraction",
    }
    if fallback_reason:
        receipt["full_fallback_reason"] = fallback_reason
    (output / RECEIPT_FILE).write_text(json.dumps(receipt, indent=2, sort_keys=True), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--scope", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--incremental", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    repo = args.repo.resolve()
    scope = args.scope.read_text(encoding="utf-8").splitlines()
    versions = require_pinned_tools()
    if args.check:
        print(
            json.dumps(
                {
                    "command": "incremental" if args.incremental else "full",
                    "scope_files": len(scope),
                    "tool_versions": versions,
                    "semantic_tokens": 0,
                },
                sort_keys=True,
            )
        )
        return
    if args.corpus is None:
        raise SystemExit("--corpus is required unless --check is used")
    corpus = args.corpus.resolve()
    output = repo / "graphify-out"
    output.mkdir(parents=True, exist_ok=True)

    detection = detect(corpus)
    state, fallback_reason = (
        load_compatible_state(output, repo, scope, versions) if args.incremental else (None, None)
    )
    changed_paths: set[str]
    if state is None:
        run_mode = "full" if not args.incremental else "full-fallback"
        changed_paths = set(scope)
        code_paths = [Path(path) for path in detection.get("files", {}).get("code", [])]
        for relative in SAFE_LOCAL_AST_OVERRIDES:
            override = corpus / relative
            if override.exists() and override not in code_paths:
                code_paths.append(override)
        ast = extract(code_paths, cache_root=corpus)
        extraction = normalize_extraction(ast, corpus)
        add_scope_nodes(extraction, scope, corpus)
    else:
        run_mode = "incremental"
        changed_paths = changed_scope_paths(repo, state["source_commit"], args.source_commit, set(scope))
        changed_code_paths = [
            corpus / relative
            for relative in sorted(changed_paths)
            if (corpus / relative).exists()
            and (corpus / relative) in {Path(path) for path in detection.get("files", {}).get("code", [])}
        ]
        for relative in SAFE_LOCAL_AST_OVERRIDES:
            override = corpus / relative
            if relative in changed_paths and override.exists() and override not in changed_code_paths:
                changed_code_paths.append(override)
        ast = extract(changed_code_paths, cache_root=corpus)
        changed_extraction = normalize_extraction(ast, corpus)
        add_scope_nodes(changed_extraction, scope, corpus, changed_paths)
        extraction = merge_incremental_extraction(state["extraction"], changed_extraction, changed_paths)

    represented = {node.get("source_file") for node in extraction["nodes"]}
    missing = sorted(set(scope) - represented)
    if missing:
        raise SystemExit(f"Graph omitted scoped files: {missing}")
    labels_present = {str(node.get("label", "")) for node in extraction["nodes"]}
    absent_labels = sorted(
        fragment
        for fragment in REQUIRED_LABEL_FRAGMENTS
        if not any(fragment in label for label in labels_present)
    )
    if absent_labels:
        raise SystemExit(f"Graph omitted required core symbols: {absent_labels}")
    graph = build_from_json(extraction)
    communities = cluster(graph)
    cohesion = score_all(graph, communities)
    gods = god_nodes(graph)
    surprises = surprising_connections(graph, communities)
    nodes_by_id = {node["id"]: node for node in extraction["nodes"]}
    labels = community_labels(communities, nodes_by_id)
    questions = suggest_questions(graph, communities, labels)

    normalized_detection = dict(detection)
    normalized_detection["total_files"] = len(scope)
    normalized_detection["scan_root"] = "."
    normalized_detection["skipped_sensitive"] = len(detection.get("skipped_sensitive", []))
    report = generate(
        graph,
        communities,
        cohesion,
        labels,
        gods,
        surprises,
        normalized_detection,
        {"input": 0, "output": 0},
        ".",
        suggested_questions=questions,
        built_at_commit=args.source_commit,
    )
    report = report.replace(
        "- Token cost: 0 input · 0 output",
        "- Semantic token cost: none; this snapshot uses deterministic AST and document-heading extraction",
    ).replace(
        "- Run `graphify update .` after code changes (no API cost).",
        "- Run `scripts/graphify-core-product.sh` after core scope or code changes.",
    )
    (output / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    (output / ".graphify_labels.json").write_text(
        json.dumps({str(key): value for key, value in labels.items()}, indent=2), encoding="utf-8"
    )
    to_json(graph, communities, str(output / "graph.json"), force=True, built_at_commit=args.source_commit)
    # Keep the required HTML artifact useful for a growing core graph without
    # silently dropping it once Graphify's full-node visualization limit is hit.
    to_html(
        graph,
        communities,
        str(output / "graph.html"),
        community_labels=labels,
        node_limit=5_000,
    )

    graphify_cli = Path(sys.executable).with_name("graphify")
    benchmark_result = run_benchmark(
        str(output / "graph.json"),
        corpus_words=int(detection.get("total_words", 0)) or None,
    )
    benchmark_buffer = io.StringIO()
    with contextlib.redirect_stdout(benchmark_buffer):
        print_benchmark(benchmark_result)
    (output / "BENCHMARK.txt").write_text(benchmark_buffer.getvalue(), encoding="utf-8")
    diagnostic = subprocess.check_output(
        [
            str(graphify_cli),
            "diagnose",
            "multigraph",
            "--graph",
            str(output / "graph.json"),
            "--json",
        ],
        cwd=repo,
        text=True,
    )
    (output / "multigraph-diagnostic.json").write_text(diagnostic, encoding="utf-8")

    manifest = {}
    for relative in scope:
        blob = subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", f"{args.source_commit}:{relative}"], text=True
        ).strip()
        manifest[relative] = {"git_blob": blob}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (output / "cost.json").write_text(
        json.dumps(
            {
                "runs": [
                    {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "method": "deterministic AST and document-heading extraction",
                        "files": len(scope),
                    }
                ],
                "total_input_tokens": 0,
                "total_output_tokens": 0,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    write_state(output, extraction, args.source_commit, scope, versions)
    write_receipt(
        output,
        args.source_commit,
        scope,
        len(changed_paths),
        graph,
        run_mode,
        fallback_reason,
    )
    print(
        json.dumps(
            {
                "source_commit": args.source_commit,
                "scope_files": len(scope),
                "changed_files": len(changed_paths),
                "nodes": graph.number_of_nodes(),
                "edges": graph.number_of_edges(),
                "communities": len(communities),
                "run_mode": run_mode,
                "full_fallback_reason": fallback_reason,
            }
        )
    )


if __name__ == "__main__":
    main()
