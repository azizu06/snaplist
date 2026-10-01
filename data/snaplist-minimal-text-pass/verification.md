# Minimal-text pass verification

Existing ready PR: https://github.com/azizu06/snaplist/pull/1172

## Devin finding disposition

Accepted: shortening ListingReviewCopy.staleReview changed the iOS response classifier. The API still returns HTTP 409 with code `conflict` and message `This review changed. Reload and try again.` (`ListingReviewStaleError`, src/lib/listing-review/save.ts; mobile handler, src/lib/mobile-api/app.ts).

The client now compares that wire message independently of presentation copy. `conflict` alone is insufficient because the server also uses it for save-in-progress and idempotency conflicts. The visible message remains `This review changed. Reload.`

Both pre-existing iOS response fixtures now send the server message instead of copying the UI constant. The store test asserts conflict phase, stale state, and the independently specified shorter announcement, while retaining permanent-refusal and in-progress controls. No new test selectors or duplicated harnesses were added.

## Evidence

- Server: `pnpm exec vitest run src/lib/mobile-api/app.test.ts -t 'exact stale-review conflict'` — 1 passed; exact 409 envelope asserted through the server handler.
- RED: `ListingReviewStoreTests/testPermanentSaveRefusalRendersTheServerRemedyNotTheRetryCopy` — failed on generic failure versus conflict, false stale state, and wrong announcement. Result: ios/DerivedData/stale-red.xcresult (ignored local artifact).
- GREEN: the same test plus `ListingReviewStoreTests/testCleanDoneDoesNotWriteAndDirtyRetryReusesOneLogicalSave` — 2 passed. Result: ios/DerivedData/stale-green.xcresult (ignored local artifact).
- Native controller: XcodeBuildMCP; explicit task-owned simulator `fm-minimal-text`, UDID `5D0AA1C4-FDB8-410B-8603-D2BA8C994F3C`, iOS 27. The first cold build exceeded the tool wait timeout; its finished prepared test package ran RED, then a warm build ran GREEN successfully. No phone action.
- Before/after: changes.html, 122 changed copy entries across 8 source files; before uses branch base 88b14626. Live prototypes and reserved redesign surfaces were not edited.
- Delivery: direct PR, no no-mistakes pipeline; no additional broad review requested, per firstmate steering. Long UI shards remain skipped under existing hackathon configuration.

- UI: `ListingReviewUITests/testConflictDefaultsToKeepEditingAndOnlyExplicitDiscardReloads` — 1 passed. Confirms shorter alert, keep-editing and explicit-discard reload controls. Result: ios/DerivedData/stale-ui.xcresult.
- Screenshot limitation: task simulator was Shutdown; install returned SimError 405 and launch reported app not installed. Firstmate resolved the blocker in instruction 005: retain the prior rendered DEL-01/02/03 and camera-off spot evidence and describe the new screenshot limitation. No optional screenshot loop or phone action. Prior rendered evidence is reported in the existing PR; no screenshots from it were present in this worktree.
- Delivery follows instructions 005/006: commit this scoped correction, safely push the same PR, record the posted-bot disposition and verify exact-head fast CI. No broad rerun or separate review. This note records local evidence; current forge CI and the exact-source Graphify receipt are recorded in the PR handoff.
