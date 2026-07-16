# Sold-comp ranking replay

- Run: `issue188-20260716T190054137Z`
- Provider requests: **0** (saved capture replay only)
- Queries: 40
- Labeled rows: 914
- Retrieval relevant precision: 82.39%

## SnapList matcher output

- Price anchors: 134
- Corroboration-only rows: 382
- Rejected rows: 398
- Anchor precision: 92.54%
- Valid comparable recall into anchors: 46.97%
- Queries with at least two price anchors: 17 (42.50%)
- Missing corpus queries: 0

## Interpretation

The provider retrieval metric and SnapList ranking metric are intentionally separate. Only price anchors may enter the median, cited source set, or minimum-two-comp pricing gate. Corroboration can support later review but cannot silently price an item.

This replay supports keeping the captured Apify evidence as a promising retrieval source while production activation remains blocked. The corpus is condition-skewed and the labels are agent-assisted rather than a completed human gold set; provider routing requires a separate owner decision after balanced-condition and Product Research validation.
