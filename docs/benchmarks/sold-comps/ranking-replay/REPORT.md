# Sold-comp ranking replay

- Run: `issue188-20260716T190054137Z`
- Provider requests: **0** (saved capture replay only)
- Queries: 40
- Labeled rows: 914
- Retrieval relevant precision: 82.39%

## SnapList matcher output

- Price anchors: 126
- Corroboration-only rows: 374
- Rejected rows: 414
- Anchor precision: 92.06%
- Valid comparable recall into anchors: 43.94%
- Queries with at least two price anchors: 17 (42.50%)
- Missing corpus queries: 0

## Interpretation

The provider retrieval metric and SnapList ranking metric are intentionally separate. Only price anchors may enter the median, cited source set, or minimum-two-comp pricing gate. Corroboration can support later review but cannot silently price an item.

The Issue #188 `reject-apify` conclusion combined provider retrieval with the prior binary matcher. This corrected replay supersedes that ranking conclusion: it supports keeping the captured Apify evidence as a promising retrieval source while production activation remains blocked. The corpus is condition-skewed and the labels are agent-assisted rather than a completed human gold set; provider routing requires a separate owner decision after balanced-condition and Product Research validation.
