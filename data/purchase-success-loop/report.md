# Purchase confirmation recovery

Frozen scope: successful sandbox purchase followed by endless native confirmation, and the account-bound async correctness required by that purchase path. Owned surfaces: ProGate store/sheet, Settings subscription scope, the existing SubscriptionClient/RevenueCat identity seam. No entitlement policy, credit, hosted/environment/allowlist, schema, design prototype, phone, or marketplace changes.

## Observed trigger, mask, symptom

- Reported trigger: a new Apple sandbox purchase after normal main `6761334e` was installed; Apple said the purchase was successful.
- Mask: the server does not return an eligible StoreKit entitlement within the six-check window (approximately five seconds plus HTTP time). An included allowance, missing/ignored event, delivery delay, unavailable request, or changed account can expose that native defect. These are distinct from the initiating purchase.
- Symptom: “Confirming your subscription” remains loading with no dismissal, recheck, or restore. The loop has actually stopped; the modal remains busy.
- Expected: only authenticated server StoreKit truth may enable Pro. Otherwise stop loading within a finite deadline and permit recheck, restore, or close without automatically purchasing again.

Phone reproduction is deliberately unavailable: the user is reviewing it, and this task forbids device automation, capture, logins, and purchases. Controlled fixtures exercise the production SwiftUI sheet and ProGateStore through SubscriptionClient/MobileAPIClient. They do not prove the new build on the physical phone or a real RevenueCat SDK entitlement.

## Causal checks and history

Ranked explanations: (1) the verification window ends before eligible server truth and leaves a permanently busy state; (2) an SDK/HTTP operation stalls with no UI deadline; (3) a response or prepared offer outlives its originating account. The earlier Apple HTTP 500 is a separate pre-purchase failure, not evidence for this new successful purchase.

The original harness compiled the production ProGateStore, SubscriptionStore, SubscriptionClient, and subscription models. A successful advisory purchase with an unchanged included entitlement printed:

```
post-purchase: confirming, dismissible: false, resume: false
FAIL: completed purchase leaves endless confirmation
```

The smallest counterfactual is the existing verified StoreKit response: it takes the same purchase path to `ready` and consumes its resume intent once. Keeping the included response unchanged while correcting exhaustion now prints:

```
post-purchase: verificationPending, dismissible: true, resume: false
PASS: bounded pending
```

A stalled-request fixture first failed with `FAIL: slow request leaves endless confirmation`; the deadline then passed that same check. Suspended response tests change only Clerk ownership and reject the old grant/offer. The disconfirming successful path remains tested: eligible server StoreKit truth produces verified success; included allowance never does. This accounts for both divergent paths without weakening billing verification.

History: the original item gate intentionally retained PAY-03/PAY-07 after exhausting polling; the earlier foreground recovery allowed another check only after a scene transition. Settings purchase entry later reused that store. These paths explain why an uninterrupted foreground purchase can remain stuck even after a grant arrives.

The three posted Devin account-switch comments on https://github.com/azizu06/snaplist/pull/1157 were inspected through the supplied triage report. They are addressed narrowly: Clerk ID participates in subscription ownership, responses target the captured reading and request generation, and prepared plans must still belong to the current scope. A green bot check was not treated as acceptance.

## Read-only external evidence

The supplied sandbox report and scoped-grant authorization were consulted. Its earlier ignored events and Apple HTTP 500 predate the newly reported success.

Read-only Supabase checks of the existing designated sandbox account on 2026-10-01 UTC found applied SANDBOX renewal webhooks beginning at 00:32:33.931Z and multiple active `storekit` allowance periods (configured allowance 30). At inspection, the latest two periods spanned 00:58:23–01:03:23 and 01:03:23–01:08:23 UTC. This proves server event application and ledger periods for that account; it does not prove the phone's current Clerk identity, SDK entitlement, exact purchase callback timing, or the entitlement response the phone saw. No tokens were minted, disclosed, or used for app authentication. No hosted writes were made.

## Implementation and validation

Production confirmation has a 20-second UI deadline covering SDK and HTTP waits. Exhaustion/cancellation becomes truthful pending. Recheck is serialized by state; restore is available; close invalidates late completion. SDK advisory outcomes never unlock Pro. Subscription requests retain their owner and generation; the SDK also refuses purchase/restore against an account that did not load the offer.

Applicable gates: diagnostic-reasoning, diagnosing-bugs, and TDD at the task-authorized production UI/store/API/subscription seams. Direct-PR fast path explicitly omits independent reviewers and long UI shards. Focused simulator evidence and final counts are recorded in the PR. Visual prototype selection remains independent.

`fm-ensure-agents-md.sh .` was run; it refused the existing distinct AGENTS.md and CLAUDE.md (the latter already points to AGENTS/PRD). These unrelated instruction files were left unchanged.

Focused validation on existing simulator `13084A2F-32DF-427F-B33F-3B59F42BB87E` (iOS 26.5), isolated `ios/DerivedData/purchase-success`:

- ProGateStoreTests, SubscriptionClientTests, SettingsTests: 101 passed.
- Three suspended Settings account-switch tests: 3 passed (configuration, entitlement, prepared plans; same email/method, different Clerk IDs).
- Final affected ProGateStoreTests after cancellation/stale-preparation guards: 25 passed.
- Final production UI tests: 4 passed, covering missing/ignored grants, HTTP deadline, recheck/delayed grant, restore, close, native cancellation, verified completion, and the initial busy state.
- Release configuration and Clerk origin contract scripts passed. The UI shard inventory records measured timings from the final run; no long UI shard was run.

XcodeBuildMCP initially timed out during the cold dependency build. That build was allowed to finish; subsequent focused test calls completed normally. The temporary host diagnostic harness was removed after RED/GREEN. Result bundles remain local tool artifacts; no generated artifacts are committed.
