#!/usr/bin/env python3
"""Contract tests for the deterministic core-product Graphify update seam."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("graphify-core-product.py")
SPEC = importlib.util.spec_from_file_location("graphify_core_product", MODULE_PATH)
assert SPEC and SPEC.loader
GRAPHIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPHIFY)


class IncrementalGraphifyContractTest(unittest.TestCase):
    def run_generator(self, *args: str) -> None:
        previous_argv = sys.argv
        try:
            sys.argv = [str(MODULE_PATH), *args]
            with contextlib.redirect_stdout(io.StringIO()):
                GRAPHIFY.main()
        finally:
            sys.argv = previous_argv

    def test_incremental_merge_replaces_changed_source_and_preserves_unchanged_records(self) -> None:
        previous = {
            "nodes": [
                {"id": "old_a", "label": "Old A", "source_file": "src/lib/a.ts"},
                {"id": "file_a", "label": "a.ts", "source_file": "src/lib/a.ts"},
                {"id": "unchanged_b", "label": "Unchanged B", "source_file": "src/lib/b.ts"},
            ],
            "edges": [
                {"source": "file_a", "target": "old_a", "relation": "contains", "source_file": "src/lib/a.ts"},
                {"source": "unchanged_b", "target": "file_b", "relation": "uses", "source_file": "src/lib/b.ts"},
            ],
        }
        changed = {
            "nodes": [
                {"id": "new_a", "label": "New A", "source_file": "src/lib/a.ts"},
                {"id": "file_a", "label": "a.ts", "source_file": "src/lib/a.ts"},
            ],
            "edges": [
                {"source": "file_a", "target": "new_a", "relation": "contains", "source_file": "src/lib/a.ts"},
            ],
        }

        merged = GRAPHIFY.merge_incremental_extraction(previous, changed, {"src/lib/a.ts"})

        self.assertEqual({node["id"] for node in merged["nodes"]}, {"new_a", "file_a", "unchanged_b"})
        self.assertEqual(
            [edge for edge in merged["edges"] if edge["source_file"] == "src/lib/b.ts"],
            [previous["edges"][1]],
        )
        self.assertNotIn("old_a", {node["id"] for node in merged["nodes"]})

    def test_state_incompatibility_uses_full_fallback_reasons(self) -> None:
        scope = ["PRD.md"]
        versions = {"graphifyy": "0.8.33", "tree-sitter-sql": "0.3.11"}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            self.assertEqual(
                GRAPHIFY.load_compatible_state(output, output, scope, versions)[1],
                "no prior graph/cache",
            )
            (output / "graph.json").write_text("{}", encoding="utf-8")
            (output / GRAPHIFY.STATE_FILE).write_text(
                json.dumps(
                    {
                        "state_version": GRAPHIFY.STATE_VERSION,
                        "source_commit": "a" * 40,
                        "scope_digest": "wrong",
                        "tool_versions": versions,
                        "extraction": {"nodes": [], "edges": []},
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                GRAPHIFY.load_compatible_state(output, output, scope, versions)[1],
                "committed scope changed",
            )

    def test_incremental_merge_prunes_deleted_source_records(self) -> None:
        previous = {
            "nodes": [
                {"id": "deleted", "source_file": "src/lib/deleted.ts"},
                {"id": "kept", "source_file": "src/lib/kept.ts"},
            ],
            "edges": [
                {"source": "deleted", "target": "kept", "relation": "uses", "source_file": "src/lib/deleted.ts"},
            ],
        }

        merged = GRAPHIFY.merge_incremental_extraction(previous, {"nodes": [], "edges": []}, {"src/lib/deleted.ts"})

        self.assertEqual(merged["nodes"], [{"id": "kept", "source_file": "src/lib/kept.ts"}])
        self.assertEqual(merged["edges"], [])

    def test_incremental_merge_preserves_unchanged_inbound_edge_to_replaced_node(self) -> None:
        previous = {
            "nodes": [
                {"id": "changed", "source_file": "src/lib/changed.ts"},
                {"id": "stable", "source_file": "src/lib/stable.ts"},
            ],
            "edges": [
                {"source": "stable", "target": "changed", "relation": "uses", "source_file": "src/lib/stable.ts"},
            ],
        }
        changed = {"nodes": [{"id": "changed", "source_file": "src/lib/changed.ts"}], "edges": []}

        self.assertEqual(
            GRAPHIFY.merge_incremental_extraction(previous, changed, {"src/lib/changed.ts"})["edges"],
            previous["edges"],
        )

    def test_impacted_records_include_new_cross_file_edge_into_changed_symbol(self) -> None:
        extraction = {
            "nodes": [
                {"id": "changed", "source_file": "src/lib/changed.ts"},
                {"id": "stable", "source_file": "src/lib/stable.ts"},
            ],
            "edges": [
                {"source": "stable", "target": "changed", "relation": "calls", "source_file": "src/lib/stable.ts"},
                {"source": "changed", "target": "stable", "relation": "calls", "source_file": "src/lib/changed.ts"},
            ],
        }

        impacted = GRAPHIFY.impacted_records(extraction, {"src/lib/changed.ts"})

        self.assertEqual(impacted["nodes"], [extraction["nodes"][0]])
        self.assertEqual(impacted["edges"], extraction["edges"])

    def test_changed_scope_paths_uses_committed_source_delta(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            source = repo / "src/lib/core.ts"
            source.parent.mkdir(parents=True)
            source.write_text("export const graph = 'before';\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(
                ["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "before"],
                check=True,
            )
            before = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
            source.write_text("export const graph = 'after';\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-am", "after"],
                check=True,
            )
            after = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()

            self.assertEqual(
                GRAPHIFY.changed_scope_paths(repo, before, after, {"src/lib/core.ts"}),
                {"src/lib/core.ts"},
            )

    def test_real_incremental_generation_updates_heading_and_preserves_unchanged_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repo"
            repo.mkdir()
            scope = repo / "scope.txt"
            prd = repo / "PRD.md"
            agents = repo / "AGENTS.md"
            prd.write_text("# Product\n", encoding="utf-8")
            agents.write_text("# Agent rules\n", encoding="utf-8")
            scope.write_text("AGENTS.md\nPRD.md\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(
                ["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"],
                check=True,
            )
            baseline = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
            corpus = Path(directory) / "corpus"
            corpus.mkdir()
            (corpus / "PRD.md").write_text(prd.read_text(encoding="utf-8"), encoding="utf-8")
            (corpus / "AGENTS.md").write_text(agents.read_text(encoding="utf-8"), encoding="utf-8")

            required_labels = GRAPHIFY.REQUIRED_LABEL_FRAGMENTS
            GRAPHIFY.REQUIRED_LABEL_FRAGMENTS = set()
            try:
                self.run_generator("--repo", str(repo), "--scope", str(scope), "--source-commit", baseline, "--corpus", str(corpus))
                baseline_receipt = json.loads((repo / "graphify-out" / GRAPHIFY.RECEIPT_FILE).read_text(encoding="utf-8"))
                unchanged_nodes = [
                    node for node in json.loads((repo / "graphify-out" / GRAPHIFY.STATE_FILE).read_text(encoding="utf-8"))["extraction"]["nodes"]
                    if node.get("source_file") == "AGENTS.md"
                ]

                prd.write_text("# Product\n## Incremental receipt\n", encoding="utf-8")
                subprocess.run(
                    ["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-am", "heading"],
                    check=True,
                )
                source_commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
                (corpus / "PRD.md").write_text(prd.read_text(encoding="utf-8"), encoding="utf-8")
                self.run_generator("--incremental", "--repo", str(repo), "--scope", str(scope), "--source-commit", source_commit, "--corpus", str(corpus))
            finally:
                GRAPHIFY.REQUIRED_LABEL_FRAGMENTS = required_labels

            receipt = json.loads((repo / "graphify-out" / GRAPHIFY.RECEIPT_FILE).read_text(encoding="utf-8"))
            state = json.loads((repo / "graphify-out" / GRAPHIFY.STATE_FILE).read_text(encoding="utf-8"))
            self.assertEqual(receipt["source_sha"], source_commit)
            self.assertEqual(receipt["run_mode"], "incremental")
            self.assertEqual(receipt["changed_file_count"], 1)
            self.assertGreater(receipt["node_count"], baseline_receipt["node_count"])
            self.assertEqual([node for node in state["extraction"]["nodes"] if node.get("source_file") == "AGENTS.md"], unchanged_nodes)


if __name__ == "__main__":
    unittest.main()
