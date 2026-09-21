---
title: Shell file and function size limits are enforced with a closed baseline
status: active
owner: eng
canonical: true
last_verified: 2026-09-21
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0107 — Shell file and function size limits are enforced with a closed baseline

**Status:** Accepted (Sep 2026), in force. Amends
[ADR 0065](0065-scripts-file-size-watchlist-scope.md), which rejected
enforcement for `scripts/` and left shell reported only.
**Scope:** ci/process

## Context

[ADR 0065](0065-scripts-file-size-watchlist-scope.md) put `.sh` files inside
the file-size watchlist and rejected enforcement. The watchlist reports; it
opens a monthly issue and never fails a pull request. Its reasons were
specific to ESLint: `eslint.config.mjs` covers `.mjs`, `.js` and `.cjs`, so a
`max-lines` rule would still miss every shell file, a per-file disable would
become the exemption mechanism with no place to record why, and the commit
adding the rule would turn `pnpm lint:scripts` red on every file already over
the cap.

Since then the repository grew 66 tracked `*.sh` files. Five hold more than
500 lines and 21 shell functions hold more than 50. Nothing stops a sixth
file or a twenty-second function from joining them, and nothing stops
`get_function_logs`, at 220 lines today, from reaching 300. The watchlist
measures files, so a 600-line file made of twelve 50-line functions and a
600-line file made of one function read the same to it.

`github.com/mento-protocol/agents` solves the measurement part.
`scripts/check-shell-size.mjs` there reads function boundaries from the shfmt
parser through `mvdan-sh`, so `function` keywords, here documents and names
such as `module::name` are read the way bash reads them, and a file the
parser rejects fails the check rather than passing unmeasured.

## Decision

**Every tracked `*.sh` file holds at most 500 lines and every shell function
at most 50.** The gate runs repository-wide on every pull request, through
`pnpm check:shell` in the `Code Quality` job of `.github/workflows/trunk.yml`.
Tests are included: a shell test file is shell, and splitting one costs what
splitting any other shell file costs.

**Code over a limit today is recorded in a closed, shrinking baseline.**
`scripts/repo-health/shell-size-baseline.txt` holds one row per exempt
subject — `<path> <count>` for a file, `<path> <function> <count>` for a
function. A row is an upper bound: the subject may shrink below it, which
prints an advisory line and still passes, so two changes that each shrink one
baselined subject merge without leaving `main` red. `SHELL_SIZE_BASE` names
the pull request's base branch, and the checker compares the two baselines, so
a row may only go down. A row the base lacks is refused, and a removed row may
not return. Splitting the recorded code is follow-up work, not part of the
adoption.

**The checker is a byte-identical copy.** It is maintained in
`mento-protocol/agents` at `scripts/check-shell-size.mjs`, with its full test
suite; a change goes there first and is copied here afterwards. This
repository keeps a smoke test beside the copy that proves the copy runs, reads
its baseline and ratchets. `mvdan-sh` is pinned to exactly `0.10.1` because
upstream deprecated it and it is still the only npm binding of the shfmt
parser that exposes `syntax.Walk` and `syntax.NodeType`.

**The watchlist stays, unchanged, for everything else.** ADR 0065's 600/1000
advisory report keeps `scripts/` JavaScript, the package `src/` trees and the
monthly issue route. Shell files stay in its report as well; the report says
how large they are, and this gate says what may merge.

## Alternatives considered

**shellcheck.** Already runs on every `.sh` file through Trunk. It has no
size rule of any kind, for files or for functions, so it cannot express this
decision.

**A Trunk custom linter.** Both modes were probed and both fail. Trunk's
`--all` mode, which this repository's `Code Quality` job uses, reports every
old issue, so the adoption would red on all 26 subjects on day one. Trunk's
changed-files mode reports only files the pull request touched, which lets an
old long function grow as long as its file is not otherwise changed — the
exact regression this gate exists to catch.

**An npm package.** One file, one dependency and one text file do not need a
registry release, a version, a changelog and a consumer bump per fix. The
copy carries its own source-of-truth note in its header, and `cmp` against
the source repository proves it.

**`sh-syntax`, the maintained successor to `mvdan-sh`.** Its AST carries no
node types and no function names, so it can parse a shell file and still not
say which function is 220 lines. It cannot measure what this gate measures.

**Enforce through ESLint instead.** ADR 0065 already rejected this, for the
reason that still holds: `eslint.config.mjs` reaches no `.sh` file.

## Consequences

- A shell change that grows a baselined subject fails required CI. The fix is
  a split, and the baseline row goes down with it.
- A renamed or moved function is a new function to the baseline, so a rename
  that keeps a 200-line body fails. Split it in the same change.
- `scripts/review/review-eval.test.mjs` caps review-eval JavaScript modules
  through `validationModuleLineLimits`. That map holds `.mjs` names only, so
  the two mechanisms cover disjoint files and cannot contradict each other.
- The baseline rows were measured against one commit of `main`. A shell change
  that lands first moves them, and the adoption re-measures rather than
  merging a stale row.
- Adding a row needs the base branch to lack it, which it never does after
  this lands. A new exemption therefore needs two pull requests, and the
  second one has to say why.

## Evidence

- The gate and its limits:
  [`scripts/repo-health/check-shell-size.mjs`](../../scripts/repo-health/check-shell-size.mjs)
- The recorded subjects:
  [`scripts/repo-health/shell-size-baseline.txt`](../../scripts/repo-health/shell-size-baseline.txt)
- The smoke test for the copy:
  [`scripts/repo-health/check-shell-size.test.mjs`](../../scripts/repo-health/check-shell-size.test.mjs)
- The CI step and its unfiltered trigger:
  [`.github/workflows/trunk.yml`](../../.github/workflows/trunk.yml) and
  [ADR 0010](0010-required-checks-no-paths-filters.md)
- The advisory report this amends:
  [ADR 0065](0065-scripts-file-size-watchlist-scope.md),
  [ADR 0059](0059-repo-owned-file-size-watchlist-scheduler.md)
- Upstream source and its suite: `scripts/check-shell-size.mjs` in
  <https://github.com/mento-protocol/agents>
