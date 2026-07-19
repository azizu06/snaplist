#!/usr/bin/env python3
"""Build SnapList's deterministic core-product Graphify artifact."""

from __future__ import annotations

import argparse
import collections
import contextlib
import io
import importlib.metadata
import importlib.util
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
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
EXCLUDED_PACKAGE_DEPENDENCY_MARKERS = ("remotion",)


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


def prune_excluded_package_dependencies(extraction: dict) -> None:
    excluded_ids = {
        node["id"]
        for node in extraction["nodes"]
        if node.get("source_file") == "package.json"
        and any(
            marker in str(node.get("label", "")).casefold()
            for marker in EXCLUDED_PACKAGE_DEPENDENCY_MARKERS
        )
    }
    extraction["nodes"] = [node for node in extraction["nodes"] if node["id"] not in excluded_ids]
    extraction["edges"] = [
        edge
        for edge in extraction["edges"]
        if edge.get("source") not in excluded_ids and edge.get("target") not in excluded_ids
    ]


def add_scope_nodes(extraction: dict, scope: list[str], corpus: Path) -> None:
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--scope", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args()
    corpus = args.corpus.resolve()
    repo = args.repo.resolve()
    output = repo / "graphify-out"
    output.mkdir(parents=True, exist_ok=True)
    scope = args.scope.read_text(encoding="utf-8").splitlines()

    if importlib.metadata.version("graphifyy") != "0.8.33":
        raise SystemExit("Graphify v0.8.33 is required for this snapshot")
    if importlib.util.find_spec("tree_sitter_sql") is None:
        raise SystemExit("Install the Graphify SQL extra: uv pip install --python ~/.local/share/uv/tools/graphifyy/bin/python tree-sitter-sql==0.3.11")

    detection = detect(corpus)
    code_paths = [Path(path) for path in detection.get("files", {}).get("code", [])]
    for relative in SAFE_LOCAL_AST_OVERRIDES:
        override = corpus / relative
        if override.exists() and override not in code_paths:
            code_paths.append(override)
    ast = extract(code_paths, cache_root=corpus)
    extraction = normalize_extraction(ast, corpus)
    prune_excluded_package_dependencies(extraction)
    add_scope_nodes(extraction, scope, corpus)

    represented = {node.get("source_file") for node in extraction["nodes"]}
    missing = sorted(set(scope) - represented)
    if missing:
        raise SystemExit(f"Graph omitted scoped files: {missing}")
    required_label_fragments = {
        "reserve_ai_item_credit_for_pipeline_run",
        "pipeline_runs",
        "UserTokenProvider",
    }
    labels_present = {str(node.get("label", "")) for node in extraction["nodes"]}
    absent_labels = sorted(
        fragment
        for fragment in required_label_fragments
        if not any(fragment in label for label in labels_present)
    )
    if absent_labels:
        raise SystemExit(f"Graph omitted required core symbols: {absent_labels}")
    if any(
        marker in f"{node.get('label', '')} {node.get('id', '')}".casefold()
        for marker in EXCLUDED_PACKAGE_DEPENDENCY_MARKERS
        for node in extraction["nodes"]
    ):
        raise SystemExit("Graph contains an excluded presentation dependency")

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
    to_html(graph, communities, str(output / "graph.html"), community_labels=labels)

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
                        "date": datetime.now(timezone.utc).isoformat(),
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
    print(
        json.dumps(
            {
                "source_commit": args.source_commit,
                "scope_files": len(scope),
                "nodes": graph.number_of_nodes(),
                "edges": graph.number_of_edges(),
                "communities": len(communities),
            }
        )
    )


if __name__ == "__main__":
    main()
