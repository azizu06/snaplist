# Apify sold-comp balanced-condition contract evaluation

- Provider requests: **0**
- Conditions: 7 (balanced)
- Synthetic input rows: 35; normalized: 28; normalization rejects: 7
- Anchor precision: 100.00%
- Valid-comp recall into anchors: 100.00%
- Two-anchor coverage: 100.00%
- Expected-outcome accuracy: 100.00%

| Inventory condition | Input | Normalized | Anchors | Corroboration | Rejected | Anchor precision | Valid-comp recall | Two anchors |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| New | 5 | 4 | 2 | 1 | 1 | 100.00% | 100.00% | yes |
| Open Box | 5 | 4 | 2 | 1 | 1 | 100.00% | 100.00% | yes |
| Like New | 5 | 4 | 2 | 1 | 1 | 100.00% | 100.00% | yes |
| Refurbished | 5 | 4 | 2 | 1 | 1 | 100.00% | 100.00% | yes |
| Used Good | 5 | 4 | 2 | 1 | 1 | 100.00% | 100.00% | yes |
| Used Fair | 5 | 4 | 2 | 1 | 1 | 100.00% | 100.00% | yes |
| Parts | 5 | 4 | 2 | 1 | 1 | 100.00% | 100.00% | yes |

This synthetic suite is a deterministic adapter/normalizer/matcher contract check, not a marketplace-quality estimate. Live retrieval precision, latency, and cost remain the measured Issue #188 evidence; the private listing-level rows are never copied into this output.
