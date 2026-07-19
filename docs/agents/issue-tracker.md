# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `azizu06/snaplist`. Prefer `gh-axi` for all
operations, falling back to `gh` only for a documented wrapper gap.

## Conventions

- **Create an issue**: `gh-axi issue create --title "..." --body-file <path>`.
- **Read an issue**: `gh-axi issue view <number> --comments --full`.
- **List issues**: `gh-axi issue list --state open --label <label> --limit <n>`.
- **Comment on an issue**: `gh-axi issue comment <number> --body "..."`.
- **Apply / remove labels**: `gh-axi issue edit <number> --add-label <label>` /
  `--remove-label <label>`.
- **Close**: `gh-axi issue close <number> --reason completed --comment "..."`.

Infer the repo from `git remote -v`; pass `--repo owner/name` when the active worktree does not make
the target unambiguous.

## Issue contract before Ready

Apply `to-tickets` once when an approved spec or parent is decomposed into child issues. Do not rerun
it on an existing child merely because the child advances to Ready. Before `Lane = Ready`, the issue
must record:

- one finite observable outcome and binary acceptance criteria;
- real blocking edges;
- owned surfaces and explicit exclusions;
- named public or external-behavior test seams approved by the user issue contract or explicit user
  confirmation;
- a proportional validation plan;
- the approved design package and plain-language screen/flow list for UI work;
- candidate and withheld state families for UI work;
- the Apple primitive evaluated, availability gate, honest fallback, and server/provider-truth
  boundary when a native capability applies.

Use one issue, one branch, one isolated worktree, and one PR. Collision-check semantic ownership across
open issues, branches, worktrees, and PR diffs before editing. A change crossing more than two major
production surfaces or roughly 15 production files / 800 non-generated production lines triggers a
mandatory hub re-scope checkpoint. The hub may keep one inseparable atomic path together only with a
written reason.

## Tracer bullets and skill gates

A tracer bullet owns one finite observable outcome. It may cross only the layers needed to prove that
outcome; it does not own the complete surrounding system. SnapList may split an independently
observable, provider-neutral backend or native public seam from its consumer when that seam is stable,
contract-tested, and explicitly blocks the consumer. This is not permission for a broad backend-first
phase.

Record the actual Matt workflow evidence:

- `to-tickets` at approved parent/spec decomposition;
- `tdd` as one public-interface RED to minimal GREEN for each changed behavior;
- `diagnosing-bugs` before fixing a regression whose cause is not proved;
- `code-review` before merge with separate fresh-context, read-only Standards and Spec reviewers.

The implementation author cannot approve either local review axis. Setup, green CI, or one self-review
does not satisfy these gates.

## Review convergence

Before review, compare the exact diff to the frozen issue contract and remove or split unasked
behavior. Once independent review starts, do not add product or architecture scope.

One review round is the combined assessment of one exact head. Run the fresh Standards/Spec pair
first, then request GitHub Codex on that exact head. The first candidate is round 1. Record
`Review round: N/3` in the PR body or a comment.
Request a replacement round only after qualifying fixes change the head. Replacement local reviews
are delta-focused unless a fix changes a security, tenancy, data, billing, provider, or other high-risk
boundary.

P0/P1 findings block. P2 blocks only for a proved in-scope acceptance, security/tenancy, data,
external-side-effect or direct-cost, unrecoverable-reliability, or required-test-validity defect. P3,
optional hardening, cleanup, cosmetics, and adjacent discoveries go to a focused existing or new issue
and do not extend the active PR. If qualifying blockers remain after round 3, stop and return to the
hub for split, redesign, or explicit owner direction.

GitHub Codex findings use the same filter and shared counter. They are independent evidence, not
automatic commands. Fix qualifying blockers. Route every valid adjacent or non-blocking finding to a
focused existing or new issue; document invalid or out-of-scope findings with evidence. Do not
optimize for a zero-comment review.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh-axi issue view <number> --comments --full`.
