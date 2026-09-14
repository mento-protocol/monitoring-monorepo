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

Each tuple is single-use. A failed admission also consumes that tuple attempt.
Admission rejects reruns and prior tuple attempts; the audit caller also
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

Use `pr_number=2408` only after the first result is classified. Preserve every
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

Only first-attempt successful runs provide supplemental retrospective dashboard-only/indexer-only
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
