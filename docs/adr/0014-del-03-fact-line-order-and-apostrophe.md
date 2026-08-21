# ADR-0014 — DEL-03's fact-line order and the deletion flow's apostrophe glyph

- **Status:** Accepted
- **Date:** 2026-08-21
- **Owner:** issue #823

## Context

`SettingsDeletionConfirmationView` (DEL-03, `ios/SnapList/Features/Settings/SettingsView.swift`)
shows three fact lines above the final account-deletion confirmation. Two artifacts described this
screen and disagreed about the order:

- The shipped view ordered them: "It's you, confirmed a moment ago…", then "Your eBay listings stay
  on eBay…", then the subscription truth line.
- The UI-truth audit at `agent-context/handoffs/snaplist-ui-truth-2026-08-07/audit/runs-settings.md`
  ordered them: eBay listings, subscription truth, then "It's you…".

`ios/DesignContracts/Resolved/V1PlusRunRev/contracts/exact-copy-catalog.json` (version
`run-rev-delta-v1.1`) does not govern this string — `DEL-` appears zero times in it, verified with a
positive control by two independent reviewers on PR #821 — so it has no jurisdiction over the order.

PR #821 reordered the lines to match the audit and was reverted before merge. The revert was not a
judgement that the audit was wrong; it was that a test-validity fix was the wrong owner for a copy
decision on a Guideline 5.1.1(v) screen two days before an App Store submission, and that PR's own
non-goals forbade touching DEL copy that #814 had frozen.

Separately, the deletion flow's apostrophe glyph was inconsistent: most seller-facing strings in this
file use the typographic apostrophe (U+2019) — `"Couldn't"`, `"iPhone's"`, `"SnapList's copies"`,
`"Confirm it's you"` — but two deletion-flow strings, `"SnapList's servers."` (DEL-06r) and `"It's
you, confirmed a moment ago"` (DEL-03), used the straight ASCII apostrophe (U+0027).

## Decision

1. **Order.** The shipped order is authoritative: identity confirmation first, then the eBay
   boundary, then the subscription truth. Identity-confirmation-first is the natural read immediately
   before a destructive confirm — it answers "is this really going to run against me" before the
   seller reads what it does. `SettingsView.swift` already matched this order; this decision closes
   the disagreement without changing it.
2. **Apostrophe.** The typographic apostrophe (U+2019, `'`) is the standard for every seller-facing
   string in the deletion flow, matching the glyph already used elsewhere in `SettingsView.swift`.
   `"SnapList's servers."` and `"It's you, confirmed a moment ago…"` were changed to U+2019.

Extending `exact-copy-catalog.json` to cover DEL states was considered and deliberately not done
here — the catalog's state keys are scoped to RUN and REV entries, and widening that scope is a
separate decision with its own review, not a side effect of settling one screen's order and glyph.
If DEL copy later needs the catalog's guarantees, that extension should be its own issue.

## Consequences

- `SettingsDeletionConfirmationCopy.factLines(subscriptionTruth:)` in `SettingsView.swift` is the
  single source for DEL-03's three lines, in this order; `SettingsDeletionConfirmationView` renders
  from it rather than an inline array literal.
- `SettingsTests.testDeletionConfirmationFactLineOrderIsPinnedToIdentityFirst` asserts the order
  against that seam. A future reorder of the array fails this test instead of shipping silent, closing
  the gap this issue found: before this change, none of the three strings appeared anywhere in the
  suite.
- The apostrophe sweep in this pass was scoped to the deletion flow only, per the issue's explicit
  non-goal against widening it further.
