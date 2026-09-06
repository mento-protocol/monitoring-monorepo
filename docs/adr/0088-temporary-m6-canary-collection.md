---
title: Temporary event-driven M6 canary collection
status: active
owner: eng
canonical: true
last_verified: 2026-09-06
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0088 — temporary event-driven M6 canary collection

**Status:** Accepted by the maintainer on 2026-09-06 for issue #2311.
This supersedes only ADR 0078's manual-only collection procedure. Its retained
checks, sample rules, spend ceiling, and separate deletion approval remain.

## Context

Manual dispatch requires the maintainer to request an audit while each PR is
still open. Waiting a week does not collect samples. M6 needs automatic
collection without a new verification service or another required check.

## Decision

Use `.github/workflows/m6-canary.yml` after `CI` and `No-skip audit` completion.
Keep a protected-main manual dispatch for recovery. Do not add a timer.
The event only wakes the collector. The collector re-reads GitHub state and
uses one fixed Actions concurrency group with cancellation disabled. It never
checks out upstream code, installs dependencies, or consumes upstream outputs,
artifacts, or caches. Its checkout is the protected workflow revision.

The short collector in `scripts/workflows/collect-m6-canary.mjs` uses the
automatic repository token. It can read contents and PRs, dispatch Actions,
and write evidence comments on #2128. Candidate execution stays in the existing
read-only `no-skip-audit.yml`. The writer does not forward its token there.
The audit repeats its immutable head/base and execution-path admission checks.
The ordinary CI run must match the selected head and branch, and its PR
association must name this PR and the current base SHA. Missing or stale
associations prevent selection. Admission also protects the CI contract source
and test entry point that loads the collector tests.

Record one immutable selection before dispatch. Treat an ambiguous dispatch
outcome as an outstanding reservation; never retry it automatically. Each
selected PR has one bot-authored evidence comment. Later pushes do not replace
its source SHA or produce another automatic audit for that PR. API errors,
incomplete evidence, and outstanding audits prevent further dispatch.

The exact cost baseline is 8,785 job-seconds through run `33909516394`.
This is 146.42 runner-minutes rounded once. The earlier 146.41-minute ledger
summed rounded run values. The collector uses the exact seconds, not that sum.
Charge later execution, including failed runs and reruns. Keep the approved
45-runner-minute per-run and 450 cumulative limits. Reserve 45 minutes before
starting another audit. A run above its limit or a failure needing
classification stops automatic spend. This is admission and post-run
accounting, not a hard real-time cancellation guarantee for parallel jobs.
Do not manually dispatch beside the automatic collector.

Receipts are pending observations, not acceptance decisions. Keep missing
author-check results, timings, formatter latency, local queue observations,
deployment proof, and failure classification explicit. Preserve the accepted
#2299 observation and its missing latency fields. Do not reselect provisional
#2291. Ten provisional merged observations over seven inclusive UTC dates
stop further automatic spend for review; they do not prove the required risk
coverage or authorize retirement. The reviewer still applies the frozen
earliest-prefix and risk-coverage rules in the M4 evidence receipt.
After eight new no-skip selections, pause further audit selection until
2026-09-10 UTC, the earliest seventh inclusive date from the accepted seed.
Package-execution changes get ordinary-CI evidence receipts without an audit.
They need manual full-graph verification and do not increase the automatic
count. Evidence-instrument changes remain excluded from both forms.

Collector job time is separate overhead. It does not enter the no-skip
runner-minute denominator. Report it separately in the final M6 receipt.

## Operation and removal

Developers open and update PRs normally. No local hook or per-PR request is
needed. The workflow publishes its discovery result in the Actions summary.
Selected observations and attention conditions are recorded on #2128.
An ineligible PR remains governed by ordinary required CI.

Disable `M6 canary collection` in GitHub Actions before a manual audit or
incident repair. Wait for existing collection and audit runs to finish.
Reconcile every pending dispatch and all spend before resuming. Do not erase
reservation comments to retry a selection. An incident disposition that
changes the collector's stop baseline needs a reviewed change and the
operator's decision; a rerun cannot clear the stop.
The reviewed restart updates the collector's `STOP` marker version after all
reservations and spend are reconciled. Retain the old stop comments as evidence.

Keep the collector non-required. It cannot delay a merge or certify a different
head. A PR merged before selection can be missed. No automatic merge, branch
update, rollback, or deletion is authorized. M6 retirement removes this workflow,
collector, and focused tests with the obsolete diagnostic. Preserve its source
run links in the final evidence receipt.

## Alternatives considered

- Manual requests retain the current coordination burden.
- A periodic collector adds idle polling and can miss short-lived PRs.
- A service, App, external scheduler, or separate result database adds permanent
  infrastructure for a temporary observation window.
- Automatic acceptance would infer facts that GitHub job results cannot prove.

## Consequences and evidence

The collector can stop conservatively on races or unavailable evidence. A
maintainer must resolve these exceptions. The normal PR path needs no session
message. The final receipt still requires human review and separate approval.

GitHub allows its automatic token to trigger
[`workflow_dispatch`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
The dispatch API can
[return the run ID](https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids/).
Issue #2311 owns live collector proof; #2128 owns sample acceptance and removal.
