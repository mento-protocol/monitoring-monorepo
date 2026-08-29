---
title: Verification Redesign Phase 0 Evidence
status: active
owner: eng
canonical: false
last_verified: 2026-08-29
doc_type: report
scope: repo-wide
review_interval_days: 30
garden_lane: notes-plans-archive
---

# Verification Redesign Phase 0 Evidence

Phase 0 records the control plane before any verification authority changes.
It changes no hook, gate, workflow trigger, cache authority, required check, or
ruleset.

The machine-readable evidence is:

- [Safeguard inventory](../metrics/verification-redesign-safeguards.jsonl)
- [Control-plane before manifest](../metrics/verification-redesign-control-plane-before.json)
- [Measurement baseline](../metrics/verification-redesign-baseline.json)
- [Architecture decision](../adr/0078-staged-verification-redesign.md)
- [Migration plan](../PLAN-progressive-verification-graph.md)

Use `pnpm verification:evidence:check` for the Phase 0 author closeout. It runs
the checker regression suite, validates the inventory schema, and compares the
fixed-source line manifest. Use `pnpm verification:manifest:write` to regenerate
that manifest. Phase 0 does not add the closeout to the gate or required CI
because this issue changes no blocking behavior. The checker does not decide
inventory completeness, safeguard meaning, risk coverage, ownership, or
routing. Reviewers own those judgments.

## Snapshot boundary

The control-plane source is
`61ab51af8cc07242a6d16b81d7ef77165d748e91`. The generated manifest counts
71,094 lines across 199 files. This total has two parts:

- 70,292 physical lines in gate-dedicated implementation and tests.
- 802 lines in shared aliases, YAML, inline shell, the full pre-push hook,
  configuration, and instructions.

The earlier 70,028-line estimate used source
`8bcb675b6b241e57435ce0e864e8511c03d9fce2`. It covered the 9,289-line Bash
entry point, its then-21,655-line Bash regression suite, and 39,084 lines under
`scripts/gate/**`. At the manifest source, the Bash regression suite is 21,760
lines. The 70,292-line dedicated total also includes the 159-line
package-script pin checker. The generated total adds shared control-plane
references. The manifest fixes this wider definition for the after comparison.

## Local behavior

Seven retained local requests had a median total duration of 1,482 seconds and
a maximum of 2,816 seconds. A later caller waited 1,800 seconds and timed out
before a command ran. The two retained queue and execution observations were:

|   Total |   Queue | Execution |
| ------: | ------: | --------: |
| 1,710 s | 1,696 s |      14 s |
| 1,306 s | 1,242 s |      64 s |

The raw `.tmp/agent-quality-gate/durations.jsonl` files expired. ADR 0076,
issue #2006, and the reviewed plan retain the values. The seven completed
requests, two queue records, and one later timeout have separate denominators.
For the two queue records, queue time equals total time minus execution time.
The retained records do not identify exact UTC windows, source SHAs, literal
argv, or the timing-capture method. Treat the two queue observations as a small
operational sample. Do not report a percentile from them.

The coordinator benchmark used
`node scripts/gate/agent-quality-gate-scheduler-benchmark.mjs` in the gate-lock
worktree. Its trace window is
`2026-08-25T22:03:01.145Z..2026-08-25T22:07:52.371Z`. Those endpoints bound the
invocation and benchmark JSON result. They are not internal phase clocks. The
denominator is one A/B fixture with one legacy execution and one coordinator
execution. It ran in a dirty worktree based on
`865403a135231107ed8968882288f11f6803e9ff`. The uncommitted tree was not
retained, so no source SHA identifies the exact measured code.

The direct author-command measurement ran 33 commands outside the gate in one
warm, dirty worktree based on HEAD
`8bcb675b6b241e57435ce0e864e8511c03d9fce2`. No `git write-tree` or other tree
hash was retained, so no commit or tree SHA binds the exact measured bytes. Its
UTC trace window is
`2026-08-28T17:35:59.992Z..2026-08-28T17:44:17.099Z`. Early records use nested
execution wall time. Later records use an outer clock across execution calls
and waits. Package lint and typecheck commands completed in 1.0 to 24.6
seconds. Normal package tests completed in 1.5 to 37.9 seconds except the
indexer test, which took 191.5 seconds.

The 37.857-second dashboard test is a clean rerun after the first invocation
yielded a live session at 30.001 seconds. The trace does not prove that the
first process ended before the rerun. The two invocations might have overlapped.

The Governance Watchdog `test` alias ran 107 unit tests successfully, then
failed because its integration phase expected a service on `localhost:8080`.
Its independent `test:unit` command passed in 2.1 seconds. The author contract
therefore uses `test:unit` as the normal local checkpoint. The documented
service-backed integration test stays conditional on its runtime prerequisite.

Code generation took 1.2 seconds for dashboard GraphQL, 2.2 seconds for the
mainnet indexer, and 1.6 seconds for the testnet indexer. The dashboard build
took 28.8 seconds. React Doctor returned in 2.2 seconds, but no dashboard source
had changed, so that value is not a representative scan. The hosted full-fan-
out run recorded a two-second full React Doctor score step.

For the 33 author-command observations, the baseline JSON record contains every
exact invocation and result. The historical Phase 0 Trunk formatter invocation
covered 13 staged candidate paths, checked 11 files, and passed in 9.11 seconds.
It predates and does not validate the final 17-file patch. The trace ran from
`2026-08-28T18:00:08.358Z` through `2026-08-28T18:00:17.340Z` in the same dirty
worktree based on HEAD
`8bcb675b6b241e57435ce0e864e8511c03d9fce2`. No exact tree hash was retained.
The historical command names ADR 0077. Integration later renumbered that file
to ADR 0078. One observation is a measured value, not a p95 claim.

## Pull request CI baseline

The 10-PR sample uses the ten most recent completed, non-cancelled CI runs from
ten distinct pull requests returned by `created=2026-08-21..2026-08-28` as of
`2026-08-28T17:14:14.810Z`. Each wall value is the GitHub Actions workflow
`updatedAt` timestamp minus its `createdAt` timestamp. The baseline stores both
timestamps, the full source SHA, latest conclusion, and attempt count for every
run.

| Metric             |    Median | Maximum | Observations |
| ------------------ | --------: | ------: | -----------: |
| CI wall time       | 1,750.5 s | 2,780 s |   10 PR runs |
| Summed runner time |   1,905 s | 3,789 s |   10 PR runs |
| Setup time         |   112.5 s |   424 s |   10 PR runs |

Ten observations do not support the plan's p95 rule. The baseline reports no
p95 for this sample. The source run IDs and raw values are in the baseline JSON.

Runner and setup totals include every non-skipped job execution across all
attempts. GitHub copies earlier successful jobs into later-attempt payloads, so
the calculation accepts a job only when its start is at or after that attempt's
creation time. A correction query for the three retried runs ran from
`2026-08-29T06:52:20.752Z` through `2026-08-29T06:52:28.450Z`. It measured
2,165, 2,577, and 2,690 runner seconds and 114, 89, and 182 setup seconds.

The setup figures include top-level `./.github/actions/pnpm-install` composite
durations and explicit workflow steps whose names start with `Install`. They
exclude checkout, standalone cache actions, setup-terraform, and other setup or
tool steps. They measure this selected subset, not total workflow setup cost.

The comparable full-fan-out proxy is the cross-attempt logical record for
Actions run 32968304840 at
`cf9906a63a96323b1ceb23e5e25f828f3ee221a6`. Attempt 1 was cancelled. Attempt
2 reran the root scripts and aggregate `ci` jobs. The current record carried 17
successful jobs from the first attempt. It is not a fresh 19-job second
attempt. The final `ci` job completed at `2026-08-26T13:11:28Z`, 2,884 seconds
after the original workflow creation at `2026-08-26T12:23:24Z`. The workflow
`updatedAt - createdAt` value is 2,886 seconds. The 19 logical job records use
2,102 summed runner seconds and 342 selected setup seconds. This equals about
35.0 runner-minutes.

This run is a full deterministic CI cost proxy. It is not a cold billed result.
It used existing caches. The root scripts job waited for a runner. GitHub's API
does not expose provider billing rounding in the job record. External Vercel
status and check results are not Actions jobs. The runner and setup totals
exclude them.

A second retained run provides the cold-cost basis. Actions run 32469559880 for
PR #1987 at immutable head
`6b7e70052c294599e1bf446265ff022845137387` completed in 613 wall seconds. It
executed 16 of 18 jobs and used 2,255 runner seconds and 419 setup seconds. All
14 pnpm-install logs reported `pnpm cache is not found`. Playwright, Foundry,
and Envio generated-data caches did restore. Terraform and autoreview root
runtime skipped. The current docs and guardrail jobs did not exist. The run
window was `2026-08-21T09:47:25Z..2026-08-21T09:57:38Z`.

The planning estimate adds retained current-job durations and measured cache
deltas to that cold-pnpm basis. The additions are 9 seconds for Playwright cold
setup, 3 for Envio code generation, 67 for Terraform, 55 for autoreview root
runtime, 71 for docs, and 11 for guardrail prose. The docs value replaces its
20-second warm install with the 47-second maximum observed cold install. The
result is 2,471 runner seconds, or 41.18 runner-minutes, and 475 setup seconds.
The setup total excludes the Envio codegen delta because the selected setup
metric excludes codegen and other tool steps. The baseline identifies every
source run, head, job, and step or job window used in the estimate.

This estimate is not an upper bound, a provider-billed result, or an observed
current no-skip run. No retained run proves every current deterministic job
with every cache missing. Foundry cold cost is unknown. The component timings
also come from different sources and dates. Before shadow execution, run the
non-required no-skip lane at immutable trusted source and base SHAs with every
cache read and write disabled. Execute every current deterministic job and
retain its timestamps. Stop before shadow if that proof breaches the
human-approved ceiling.

Across the same ten pull request heads, the first terminal live-ruleset result
had a median of 9 seconds and a maximum of 102 seconds. GitHub records these
timestamps at one-second precision. This produces two valid zero-second
observations. The query unions check-runs and legacy commit statuses. It binds
each result to the workflow, full head SHA, result surface, result ID, terminal
time, and app or provider identity. It excluded two Vercel results that
completed before the selected workflow creation anchor. Ten observations are
too few for a p95.

The first useful failure sample classifies retained logs from the five latest
failed runs in the failed-run selection. All five failures were actionable.
Three were control-plane test failures. Two were ESLint failures. The median
time from workflow creation to the classified failed job was 367 seconds. The
maximum was 973 seconds. No observations were excluded. Five observations are
too few for a p95.

## Reliability observations

The reliability sample uses only the same ten run IDs and full head SHAs. All
ten final attempts succeeded, so final failure yield is `0 / 10 = 0%`. Three
initial attempts failed, so initial-attempt failure yield is `3 / 10 = 30%`.
Three runs had a second attempt. Retry rate is `3 / 13 = 23.08%` over all
workflow attempt executions. Retried-run share is `3 / 10 = 30%`.

The job query ran from `2026-08-28T21:07:24Z` through
`2026-08-28T21:07:41Z`. It used `gh run view RUN --attempt N --json
createdAt,jobs`. It counted a completed non-skipped job only when the job start
was at or after the attempt creation time. This filter removes successful jobs
that GitHub copies into later-attempt payloads. Manual log classification ran
from `2026-08-28T21:16:28Z` through `2026-08-28T21:16:32Z`.

`Lint + test root scripts` had three classified flaky executions over 11
executed attempts, or 27.27%. Each failed for a confirmed test-infrastructure
reason and passed on the same head. The other 18 independent jobs had zero
classified flakes, with individual denominators from one to ten executions.
The aggregate `ci` job also failed and recovered three times over 13 attempts.
It is derivative, so it is not an independent suite denominator.

This ten-run same-head manual-rerun sample is small. GitHub retains the raw job
and log detail for 90 days. Several suite denominators are one. The sample
misses failures fixed by a new push. It cannot approve cutover.

## Metric contracts

GitHub retains Actions jobs, logs, and artifacts for 90 days. We do not rely on
an undocumented retention period for GitHub check-run or commit-status API
records. The committed receipt remains in repository history. `eng` owns
collection and classification. A human maintainer owns spend and cutover
approval.

| Metric                         | Source and retention                                                                 | Formula and denominator                                                                                                                                                                            | Ceiling and stop condition                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local queue time               | ADR 0076 and #2006 retained records; raw local files expired                         | `total - execution`; two observations; exact UTC window, source SHA, literal argv, and capture method unavailable                                                                                  | Post-cutover value must be zero because no hook can take a gate slot. Stop cutover if a local checkpoint waits on shared gate state.                                                                    |
| Local execution time           | Same retained records                                                                | Command runtime after admission; two observations; exact UTC window, source SHA, literal argv, and capture method unavailable                                                                      | Direct author commands target below two minutes. Record and optimize the 191.5-second indexer test before it becomes a hard local latency promise.                                                      |
| Staged formatting              | Actual staged candidate; base HEAD, command, UTC trace, and exact-tree limit persist | One hook wall-time observation; future p95 needs at least 20 comparable observations                                                                                                               | Target p95 below 10 seconds. Stop hook expansion if it runs package checks, fetches, generates, or takes a shared lock.                                                                                 |
| Author commands                | Warm dirty local run; base HEAD, UTC trace, and exact-tree limit persist             | 33 terminal invocations; mixed nested execution and outer elapsed clocks as recorded                                                                                                               | No spend ceiling. Keep each required command direct. Stop and revise a mandatory mapping when prerequisites make it fail in a normal worktree.                                                          |
| CI wall time                   | Actions workflow timestamps; live detail retained 90 days                            | `workflow updatedAt - workflow createdAt`; ten distinct PR-event workflow runs                                                                                                                     | Do not claim p95 below 20 heads. Stop cutover if the accepted shadow sample regresses from the Phase 0 distribution without a recorded decision.                                                        |
| First terminal required result | Check-run and commit-status timestamps; committed receipt persists                   | Earliest terminal live-ruleset context minus workflow creation; one value per head                                                                                                                 | Report median and maximum for 10 heads. Future p95 target is 120 seconds only after at least 20 comparable heads. Stop if result source binding is unclear.                                             |
| First useful failure           | Failed-job timestamp plus manual failure classification; live logs retained 90 days  | First classified actionable failure minus workflow creation; one value per failing or fault-injected run                                                                                           | Future p95 target is 120 seconds over at least 20 comparable runs covering all PR risk classes. Proxy-only data cannot approve cutover.                                                                 |
| Runner minutes                 | Actions job timestamps; live detail retained 90 days                                 | Sum all non-skipped job executions across attempts after copied-job deduplication, then divide by 60; one sampled workflow run across all its attempts is one observation                          | Recommend 45 minutes per no-skip run and 450 minutes total. Do not start without human approval. Suspend after one run exceeds the approved 45-minute per-run ceiling or the approved total is reached. |
| Setup time                     | Selected install-step timestamps; live detail retained 90 days                       | Across all attempt-scoped jobs, sum top-level `pnpm-install` composite durations and explicit `Install…` steps; excludes checkout, standalone cache actions, setup-terraform, and other tool setup | No independent spend ceiling. Stop cache hardening if a cache hit skips a required command or a PR job can save.                                                                                        |
| Retry rate                     | Actions run-attempt records; live detail retained 90 days                            | Extra attempts divided by all workflow attempt executions                                                                                                                                          | Target below 1% over at least 200 workflow attempt executions. Stop cutover when the classified shadow value exceeds the target.                                                                        |
| Failure yield                  | Terminal workflow conclusions; live detail retained 90 days                          | Failed initial or final attempts divided by their ten-run denominators                                                                                                                             | Diagnostic only; no ceiling until causes are classified. Stop a rollout for any false success or safeguard omission.                                                                                    |
| Per-suite flake rate           | Job attempts and classified logs; live detail retained 90 days                       | Classified flaky executions divided by executed, non-skipped suite runs                                                                                                                            | Target below 0.5% over at least 200 executions per suite. Use a separate browser budget. Stop cutover if any suite lacks its denominator, owner, or accepted exception.                                 |

## Current CI authority

The active `main` ruleset is ID 13494367. It has deletion,
non-fast-forward, linear-history, pull-request, thread-resolution, and required-
status rules. Strict required-status checking is off. No merge-queue or
required-workflow rule exists. Organization administrators have an `always`
bypass, and the collection user can bypass.

The required contexts are exactly:

- `Vercel`, app 8329.
- `Vercel Preview Comments`, app 8329.
- `Code Quality`, app 15368.
- `ci`, app 15368.
- `Sentry suites`, app 15368.

The existing `ci` aggregate names 19 prerequisite jobs. Its conditional-job set
equals its `allowed-skips` set. `changes`, `guardrail-prose`,
`production-infra-contract`, and `sentry-suites` cannot skip. This issue does
not alter that contract.

Current pull request authority exceptions remain in place for Phase 0:

- Package jobs grant `checks: write` before some candidate commands.
- Codecov receives its token after candidate install, build, and test steps.
- `setup-node` saves pnpm caches implicitly in pull request jobs.
- Schema-diff runs candidate-controlled filter, setup, and parser code with
  `pull-requests: write`. Its `pnpm-install` step can also save the implicit
  setup-node cache after candidate checkout.
- Direct `actions/cache` steps can save UI, indexer, Lighthouse, and Trunk data.
- Four same-repository Terraform plan workflows use `id-token: write`, can
  write pull request comments, and use GCP plan identities that can read
  cleartext Terraform state values. Alerts Infra and Governance Watchdog also
  declare `issues: write`.
- Dependabot auto-merge declares `contents: write` and
  `pull-requests: write`. It runs no candidate command.
- Claude review declares `issues: write`, `pull-requests: write`, and
  `id-token: write`, and receives its OAuth secret.
- The trusted Lighthouse preview lane declares `issues: write` and
  `pull-requests: write`, and receives a Vercel bypass secret. Its fixture lane
  is secretless.

The platform `infra.yml` pull request lane is secretless and read-only. It does
not use id-token authority, but it is not a required context. Issue #2124 must
narrow or explicitly accept the listed exceptions before CI becomes the sole
source-validation authority. It must split schema validation from the narrow
trusted sticky-comment mutation and make the schema-diff cache restore-only.

Sentry suites is the positive ordering example. It has contents-read authority,
no secret, and runs its built-in gate before install or other pull request code.

## Worktrees and mixed versions

`git worktree list --porcelain` reported 25 registered worktrees at
`2026-08-28T17:27:56.252Z`. The count was 24 during planning and can change
again. A prune dry run proved no stale registration.

The baseline JSON classifies the gate-redesign and gate-lock worktrees as
`supported active`. It classifies the other 23 registrations as
`owner-confirmation required`. It classifies none as stale. This conservative
classification prevents Phase 0 from deleting another session's work.

Before cutover, refresh the list. Keep the legacy `run.lock` while an active
supported worktree can still run the old gate. Do not use `--no-lock`. Do not
clear or repurpose live coordinator state. Remove mixed-version compatibility
only after owners confirm that no supported old worktree remains.

## Issue 2042 consumer audit

Issue #2042 closed as completed on 2026-08-29 through PR #2131 at terminal
commit `e0346ec4756f9577bcbb1e13e06566ccc507e9e4`. Its snapshot at
`8e2965a6ffbd92bcc0c2793a6892754e4c674a6b` remains provisional evidence.
Before cutover or deletion, issues #2127 and #2128 must re-audit the terminal
code by consumer.

| Consumer                                                       | Provisional disposition                  | Required invariant                                                                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate coordinator, routing, prewarm, and gate-only Trunk checks | Candidate for retirement with the gate   | Re-audit terminal commit `e0346ec4756f9577bcbb1e13e06566ccc507e9e4` by consumer before cutover or deletion in #2127 or #2128.                                           |
| Darwin process identity and lineage                            | Retain for every independent consumer    | Never signal a bare PID or process group without matching non-reusable identity. Settle coherent lineage before release. Fail closed on unsupported self-daemonization. |
| Autoreview                                                     | Retain provenance behavior               | Bind child processes and evidence to the verified review runtime.                                                                                                       |
| Sentry broker                                                  | Retain verified-leader behavior          | Signal a detached group only while its verified leader is alive. Never reuse its PID or group after reap.                                                               |
| Trunk daemon                                                   | Classify or contain before cutover       | Treat it as a bounded trusted external service or contain it.                                                                                                           |
| Legacy `run.lock`                                              | Retain through mixed-worktree transition | Do not let a new path run beside an older gate that owns the lock.                                                                                                      |

Issues #2006, #2032, and #2094 remain open with their current owners and states.
Issue #2042 is closed. The inventory preserves its Phase 0 snapshot and requires
a terminal-code consumer audit before cutover or deletion.

## Shadow spend recommendation

Recommend 45 runner-minutes per no-skip execution and 450 runner-minutes for
the initial 10-PR sample. Before shadow, run the all-cache-disabled proof above.
Do not start if it exceeds the human-approved per-run ceiling or projects the
sample above the approved total. Suspend shadow after one run exceeds the
approved 45-minute per-run ceiling or cumulative use reaches the approved
total.

This is a recommendation. It is not an approval. A human maintainer must approve
both the ceiling and stop condition before issue #2126 starts shadow runs.
