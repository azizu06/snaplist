#!/usr/bin/env python3
"""Contract tests for the deterministic core-product Graphify update seam."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("graphify-core-product.py")
SPEC = importlib.util.spec_from_file_location("graphify_core_product", MODULE_PATH)
assert SPEC and SPEC.loader
GRAPHIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPHIFY)


class IncrementalGraphifyContractTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
