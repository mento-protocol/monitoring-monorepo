---
title: scripts/ is inside the file-size watchlist, with named-mechanism exemptions
status: active
owner: eng
canonical: true
last_verified: 2026-08-18
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0065 — scripts/ is inside the file-size watchlist, with named-mechanism exemptions

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

`scripts/repo-health/file-size-watchlist.mjs` reports source files over the
600-line soft cap or the 1,000-line hard cap, and
[ADR 0059](0059-repo-owned-file-size-watchlist-scheduler.md) routes the
actionable rows into one monthly issue. Its scope was six package `src/` trees.
`scripts/` was in none of them.

That gap followed from where the caps come from. Each scope mirrors a package
ESLint config that sets `max-lines`. The root `eslint.config.mjs` covers
`scripts/**/*.{mjs,js,cjs}` for correctness rules only and sets no `max-lines`,
so there was no config for the watchlist to mirror and no lint rule behind a
`scripts/` row. The repo rule to register a split module in the watchlist has
therefore been vacuous for `scripts/` the whole time.

The tree noticed before this ADR did.
`scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs` carries a hand-maintained list of
20 paths, imports `countLines` and `HARD_CAP` from the watchlist, and fails when
one of them crosses 1,000 raw lines. Its comment gave the reason outright — "the
root ESLint config sets no `max-lines`, and the file-size watchlist scopes the
package `src/` trees, not scripts/" — and this change corrects it. One subsystem
built its own gate because the shared one could not see it.
`sentry-autofix-select.test.mjs` and `sentry-triage-brief.test.mjs` pin their
legs' modules the same way, for the same reason.

Meanwhile the tree grew to 251 tracked files, including the four largest files
in the repository. The `scripts/` reorganization
([ADR 0064](0064-scripts-module-directories.md),
[issue 1877](https://github.com/mento-protocol/monitoring-monorepo/issues/1877))
split seven modules across P1–P12 and made the tree navigable, but nothing
reports when a file there regrows.

## Decision

`scripts/` is a watchlist scope at any depth. Its extensions mirror what the
root ESLint config lints — `.mjs`, `.js`, `.cjs` — plus `.sh`; only `.mjs` and
`.sh` exist there today, and the other two are listed so a first `.cjs` lands
inside the scope rather than beside it. The reporter's standing exclusion for
generated trees still applies first; `scripts/` has no generated tree today, so
nothing is lost to it.

**Tests are excluded, as in every scope but Aegis.** Package configs set
`max-lines: off` for tests, and `scripts/` tests inherit that rule rather than a
new one. The reason is not only consistency: splitting a `scripts/` suite is
per-file work a size row cannot describe. A Sentry suite's pass-count floor in
`sentry-suite-manifest.json` must be re-measured; an enumerated `ci.yml`
paths-filter must gain the new basename or the job silently stops running;
`deploy-staging-contract.test.mjs` is the single path the callsite contract
excludes from self-scanning, so a sibling holding its inert examples fails the
contract closed; `tf-stacks.test.mjs` is the verified importer for the
provider-contract exemption route. A monthly row saying "1,771 lines" beside any
of those is noise, and there would be 38 such rows — 36 of them actionable —
burying the two that matter. Where the tree wanted a test-side gate it already
built one: `check-sentry-suites-in-ci.test.mjs` hard-caps 20 paths, and the
select and brief Sentry legs pin their own modules the same way.

**`.sh` files count, on hash-comment semantics.** `countLines` takes a
`hashComments` option, applied to `.sh` paths. Without it a shell `#` comment
counts as code and the `rough` column overstates every shell file. It is a
line-prefix approximation, not a shell parser — a heredoc payload line starting
with `#` reads as a comment — so `raw` remains the exact measure.

**A file whose split would be a security decision is exempt, and the report says
so beside it.** `SCRIPTS_EXEMPTIONS` in the watchlist holds the list, by exact
path — a pattern would let it grow without a reviewer seeing which files joined.
An exempt row keeps its measured counts and its cap status, gains a one-line
reason, and prints in a separate table under the actionable one. It never opens
an issue and never fails a `--fail-on` run. It is never silently dropped: a
dropped row is the failure class this programme's P0 phase fixed in the
deploy-anchor test, where a check that matched nothing still exited 0.

Three files qualify, all in the autoreview trust root. Neither mechanism below
makes a split physically impossible — both are path lists that a determined
change could extend. Both make extending them a change to how the autoreview
wrapper proves its own integrity, and this repository does not make that change
to satisfy a line count.

| File                                                | Mechanism                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-autoreview.sh`                               | `verify_current_wrapper_matches_ref` hashes the wrapper's own blob against the frozen-HEAD snapshot before an explicit branch or commit review. A sourced sibling falls outside the identity that check proves, so moving bulk out weakens the property rather than preserving it.                           |
| `agent-autoreview.mjs`, `agent-autoreview-core.mjs` | The wrapper materializes exactly these two helper names under a 2 MB aggregate cap, from six literal lists — `helper_paths`, two `runtime_paths` arrays, an `lstat` loop, an ACL loop, and a Perl `@names` copy list that assigns each name its own file mode. Admitting a third rewrites that materializer. |

**Nothing whose split is merely expensive is exempt.** `agent-quality-gate.sh`
is the largest example and stays in the report: it is the entire subject of
[issue 1498](https://github.com/mento-protocol/monitoring-monorepo/issues/1498),
which decomposes it into sourced helper modules, so exempting it would suppress
exactly the row that already has an owner. `pr-ready-state{,-core}.mjs` sit
behind `materialize_feedback_runtime`'s two basename lists, required and
optional, which already prove themselves extensible: `pr-feedback-state-claude.mjs`
is the optional entry, and the D3 move (issue 1877) added a location resolver
under both lists without touching either name. Two appendable arrays are not the
six-list materializer above it. For
`deploy-staging-{contract,callsite-discovery}.mjs` only the _test_ is the
callsite contract's single self-scan exclusion. All four stay measured. A file
the reorganization already brought under the cap carries no entry.

**The list is reviewed with this ADR, on its 90-day interval, and whenever one
of the named mechanisms changes.** `file-size-watchlist.test.mjs` enforces the
three ways it rots. The exempt path set is spelled out in the test, and the test
also asserts this file records each path, so adding or dropping an entry reds
until this record moves with it. Each exempted file must still exist and still
be above the watch threshold, so one that shrank or moved reds. And the wrapper
must still carry all six two-name lists and the 2 MB cap the reason cites. A
further test proves the suppression is the exemption's work, not the scope's, by
scanning identical content at an exempt path and at a plain sibling.

## Alternatives considered

**Add `max-lines` to the root ESLint config instead.** The caps would be
enforced, not reported. Rejected: `eslint.config.mjs` covers `.mjs`, `.js`, and
`.cjs`, so it would still miss both large shell files, per-file disables would
become the exemption mechanism with no place to record why, and the commit
adding the rule would turn `pnpm lint:scripts` red on every file already over
the cap.

**Include tests, and exempt the pinned ones.** This was the original plan.
Rejected on measurement: of the test files a plan named unsplittable, only
`deploy-staging-contract.test.mjs` actually cannot take a sibling. A Sentry
suite may extract non-suite helper modules — the gate closes over its transitive
imports, so only a new `*.test.mjs` is barred. `tf-stacks.test.mjs` and
`agent-autoreview.test.sh` are facades that may import or source extracted
siblings. Writing those as mechanical bars would have put false reasons in the
report; writing them honestly leaves 36 actionable rows nobody will work, which
is how a watchlist gets ignored from its first run.

**Scope `scripts/` but report only hard-cap rows.** Quieter, and every row a
real breach. Rejected: it changes the reporter's meaning for one scope, and the
soft rows are the early warning the tree most needs, since nothing else measures
`scripts/` at all.

**Exempt everything currently over the cap and gate only future growth.** A
clean report on day one. Rejected: padding. It would bury two hard-cap files
that nothing holds in place.

## Consequences

- The scheduled run reports against a checkout of the default branch
  ([ADR 0059](0059-repo-owned-file-size-watchlist-scheduler.md)), so this scope
  reaches the monthly issue only after merge.
- `docs/notes/file-size-watch.md` is refreshed in the same change. Leave it
  stale and every new soft-cap row reads as fresh drift: 15 rows go actionable
  at once, or 29 against no parseable baseline at all. Refreshed, the queue is
  three, all at hard or near-hard.
- Two `scripts/` files join that queue: `agent-quality-gate.sh` and
  `sentry-triage-archive.mjs`. Both are over the hard cap with nothing holding
  them, and the first already has an issue.
- **The gate's row shrinks by roughly 40% at D5c, and the residual is the
  process-control layer by design.** Measured on `2e3df696`: the gate is 6,163
  raw lines, of which the mapping layer — the verb helpers, the thirteen `case`
  statements and the four post-passes at `2099-4704` — is 2,606, and the D5c
  soak guard adds 38 more. Deleting those leaves **~3,519 raw / ~2,266 rough**,
  against the ~3,300 the design projected. That residual is not a file waiting
  to be split: it is the run lock, the watchdog, the orphan drain, process
  capture, teardown and signal handling, plus the execution engine and the
  stamps — the two layers [ADR 0069](0069-gate-routing-table-as-data.md)
  deliberately left in bash because their safety argument rests on `mkdir`/`link`
  atomicity, `ps -o lstart=`, Bash 3.2 job-control PGIDs and `/proc`, with no
  oracle for a rewrite. It stays in the report, over the cap, and stated rather
  than exempted.
- Thirty further `scripts/` files sit between the watch threshold and the
  hard cap. They are recorded and delta-tracked, and any that grows by more than
  100 raw lines becomes actionable on its own. The 2026-08-23 refresh produced
  the first such row —
  `scripts/sentry/triage/sentry-triage-requeue.mjs` at +117 raw, from the
  fail-open and race fixes in #1950 and #2003. The row stays in the table, as
  every row does; what the breach adds is
  [issue 2022](https://github.com/mento-protocol/monitoring-monorepo/issues/2022),
  because the Delta column is measured against whatever the checked-in report
  last said and resets to 0 on the next refresh. The table keeps the size; the
  issue keeps the fact that it moved.
- `scripts/` test files stay outside this report. Twenty-four are over 1,000 raw
  lines, and none of them is in the 20-path list in
  `check-sentry-suites-in-ci.test.mjs` — that list holds nine test files of its
  own, all currently under the cap it enforces. The gap is deliberate and named here
  rather than left implied. Closing it means a suite pinning its own subjects,
  the pattern `sentry-autofix-select.test.mjs` and `sentry-triage-brief.test.mjs`
  already use, not widening this scope.
- A future exemption is an ADR change. Adding one means editing this record and
  `SCRIPTS_EXEMPTIONS` in the same PR — the test reds unless both move —
  alongside the pin list in `scripts/AGENTS.md` that ADR 0064 already requires.

## Evidence

- Scope and exemptions: [`scripts/repo-health/file-size-watchlist.mjs`](../../scripts/repo-health/file-size-watchlist.mjs)
- Exemption mechanics and the non-tautological proofs:
  [`scripts/repo-health/file-size-watchlist.test.mjs`](../../scripts/repo-health/file-size-watchlist.test.mjs)
- No root `max-lines`: [`eslint.config.mjs`](../../eslint.config.mjs)
- The subsystem-local gate this leaves in place:
  `scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs`, "the checker's
  own files stay under the file-size hard cap"
- Trust-root pins: `verify_current_wrapper_matches_ref` and
  `materialize_filesystem_autoreview_runtime` in `scripts/agent-autoreview.sh`
- Test-split costs behind the exclusion:
  [`scripts/sentry/gate/sentry-suite-manifest.json`](../../scripts/sentry/gate/sentry-suite-manifest.json)
  and [ADR 0062](0062-sentry-suites-self-run-gate.md); `verifyExemptRoute` in
  `scripts/sentry/gate/sentry-suite-gate.mjs`; `CONTRACT_FIXTURE` in
  `scripts/deploy-staging-callsite-discovery.mjs` and
  [ADR 0053](0053-explicit-deployment-source-staging.md); the silent-skip
  failure mode of enumerated paths-filters in
  [ADR 0064](0064-scripts-module-directories.md)
- Report and cadence: [ADR 0059](0059-repo-owned-file-size-watchlist-scheduler.md),
  [`docs/notes/file-size-watch.md`](../notes/file-size-watch.md)
- Programme tracking issue:
  <https://github.com/mento-protocol/monitoring-monorepo/issues/1877>
