---
title: M6 audit recovery
status: active
owner: eng
canonical: true
last_verified: 2026-09-14
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0098 — Supplemental M6 audit recovery

**Status:** Approved for implementation by the maintainer on 2026-09-14.
[Recorded consent](https://github.com/mento-protocol/monitoring-monorepo/issues/2128#issuecomment-5666724398).
Merge approval remains separate. Refs #2416 and #2128.

## Context

Dashboard PR #2399 and indexer PR #2408 merged before their no-skip audits.
Each ordinary PR and main workflow skipped eleven retained jobs. The open-PR
admission in ADR 0088 correctly refuses retrospective execution. Main success
and clean merge reconciliation do not supply those missing executions.

## Decision

Add `m6-audit-recovery.yml`, a temporary manual protected-main adapter for only
these recorded tuples:

| PR    | Source                                   | Merge                                    |
| ----- | ---------------------------------------- | ---------------------------------------- |
| #2399 | e771a3a4be4c32c98322e494412ae064f2a328a2 | 275207b77c85942837e26e158ba9fe78affff57a |
| #2408 | 645b8197ce5a0a96301f6425889592b5782bfb6e | 199df9dcace086097540a2a8a4edacb9c0ea703d |

The historical base is `c186a7e5ca0433c80d7588acb4ab38f24988ccc7`.
After identity admission, fetch the exact approved source from the canonical
public repository; squash-merged heads may be absent from branch history.
The helper proves exact repository, head, merged state, main ancestry,
historical merge-base and clean merge tree. It checks every historical
protected path between source and base. Between runtime and base it permits
only the reviewed admission contract/test changes; retained CI, actions,
dependency inputs and the original dispatcher remain unchanged.

Keep the original open-PR dispatcher unchanged. Execute the existing retained
CI with exact source/base inputs, read-only permissions, no secrets, no cache
reads or writes, no publication, no deployments and no candidate status writer.
Admission runs the helper from the protected workflow checkout, never from the
historical candidate. The new helper and its tests have fixed root CI ownership
through `check-ci-contract.test.mjs`; the full adapter is pinned by its test.

The original authorization made each tuple single-use. After #2399 run
[34872200578](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/34872200578)
failed its browser ledger assertion, the operator
[approved one finite amendment](https://github.com/mento-protocol/monitoring-monorepo/issues/2128#issuecomment-5667946775).
Issue #2423 implements it through an independent session. The failure remains
unclassified beyond the observed assertion timeout. Original exact-head CI
passed the same test, and five unchanged local repetitions passed. Those
results do not prove an infrastructure cause. GitHub retained no uploaded
trace artifact for the failed run.

Permit exactly one fresh #2399 run and the unused #2408 run. Pin the failed
run's native identity, workflow revision, first attempt, status, conclusion,
timestamps and called workflow, plus all 19 job identities, outcomes and
timestamps. A SHA-256 digest over a fixed projection with jobs sorted by ID
binds that receipt. Read the full run through `getWorkflowRun`; do not rely on
the run-list projection alone. Preserve its 1,396 job-seconds and consumed
selection. The reconciled total is 28,983 seconds, or 483.05 minutes. Five of
the prior six additional selections remain; this amendment uses at most two.

Only that exact failed run is exempt from prior-failure and duplicate-tuple
rejection. Any missing or changed receipt, new ordinary audit, unknown recovery,
additional duplicate, rerun or further failure stops admission. A prior fresh
recovery must be the other tuple and use the same protected-main workflow
revision as the current run. If main changes between them, stop for review.
A failed admission also consumes its fresh tuple attempt.
Admission rejects reruns and all other prior tuple attempts; the audit caller also
requires attempt 1. Do not manually rerun individual retained jobs. GitHub may
reuse successful admission during partial reruns; that provider behavior has
not been verified for this adapter. Any actual rerun remains chargeable and
stops further recovery pending review. Keep the automatic collector
disabled and drained. Never dispatch an ordinary audit beside recovery. The
recovery concurrency group does not cancel a running audit; dispatch the second
recovery only after the first finishes and its failure/spend are classified.

The exact baseline is 27,587 job-seconds through run `34836768852`, completed
2026-09-14T11:14:19Z. A later modification to any earlier audit blocks admission
until reconciliation receives separate review. Sum later actual job executions
across attempts; deduplicate copied successful jobs using their execution
identity. Reserve 2,700 seconds before dispatch under the 48,000-second ceiling.
Stop for a prior run above 2,700 seconds or exhaustion of the six remaining
additional selections. These are admission and post-run limits, not a hard
real-time cancellation guarantee for parallel jobs.

## Operation

After this implementation is reviewed and separately approved for merge, verify
its protected-main revision. Reconcile the ledger and dispatch one tuple:

```bash
gh workflow run m6-audit-recovery.yml --repo mento-protocol/monitoring-monorepo --ref main -f pr_number=2399
```

The failed run is already classified for this bounded amendment; its cause
remains unknown. After separate approval to merge this implementation, either
newly authorized tuple may run first. Use `pr_number=2408` for the indexer
observation. Dispatch the other tuple only after the first new run succeeds
and its spend is reconciled. Any further failure stops both execution and
acceptance. Do not rerun an existing run or individual job. Preserve every
attempt's job timestamps, failed jobs and cost. Record ordinary CI, the exact
source/base/workflow identities, the merge proof and service-specific production
closeout. A failure found only by the complete graph still stops acceptance.

Before acceptance, read GitHub's native run event, branch and workflow SHA.
Require `workflow_dispatch`, `main` and the reviewed protected-main revision,
then reconcile the admitted tuple and complete retained graph. A workflow
summary alone cannot establish provenance. Branch-edited runs cannot qualify.
Repository writers can already run arbitrary branch workflows; this lane does
not restrict repository-wide writer spend. The approved ceiling governs the
recovery operations described here.

Only successful first attempts of the two newly authorized runs provide supplemental retrospective dashboard-only/indexer-only
coverage. They do not change the selected ten-PR cohort, observation dates,
timing decision, pre-merge readiness, or merge authority. This is an explicit
extension to the frozen evidence forms, not an assertion that prior runs met
them. Remove the adapter, helper and tests during approved M6 retirement after
preserving their evidence links.

## Alternatives and consequences

Using ordinary/main CI cannot prove skipped jobs. Artificial PRs would measure
different observations. Widening the existing open-PR admission would change
normal selection. The finite adapter keeps that boundary intact, at the cost of
a temporary reviewed implementation and two explicitly identified later runs.
