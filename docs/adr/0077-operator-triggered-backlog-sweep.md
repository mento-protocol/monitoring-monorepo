---
title: Operator-triggered backlog sweep with isolated workers
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
scope: process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0077 — Operator-triggered backlog sweep with isolated workers

**Status:** Accepted (Aug 2026), amended by M5 in 2026-09.
**Scope:** process

## Context

[ADR 0007](0007-agent-quality-gate-and-merge-oracle.md) gave the repo a local
quality gate and a merge oracle. The `rank-backlog` skill added stage 1 of a
ranked-backlog loop: it scores the open backlog, writes a receipt, and stops at
a recommendation. Acting on that receipt stayed manual. An operator claimed each
issue, set up each checkout, and re-derived the same unattended-work guardrails
every night.

Issue
[#2071](https://github.com/mento-protocol/monitoring-monorepo/issues/2071)
tracked stage 2. Its grooming decisions settled the trust model in favour of an
operator-started run rather than a scheduled one.

Subagents cannot wait across turns. A worker polls each author check in-turn.
The orchestrator re-invokes a worker that goes quiet.

M5 replaced worker gates. Each worker uses the direct author checks in step 3 of
the operating card. The legacy coordinator now serves only the diagnostic gate.
The sweep schedules direct checks by local CPU and memory use.

Review rounds dominate cost. One shipped PR costs roughly 3% of the weekly
usage window, and each push buys another bot review round whose findings cost
replies and often another push.

## Decision

A sweep is an operator-started session that ranks, picks the eligible top N,
claims each issue by number, and drives each through its own worker to a
ready-for-review PR. It stops at READY and prints the PR links for the operator.

- **The operator starts every run.** No schedule, no self-triggering.
- **The session is an orchestrator.** It runs no author check, edits no source
  file, and opens no PR. It selects, claims, keeps workers moving, and writes the
  report.
- **One worker per issue, one isolated checkout per worker.** Each worker owns a
  clone it alone commits from, proven by a marker inside `.git/`.
- **Claims use the issue-board transaction.** Each issue gets a stable Claim ID,
  and the helper revalidates the machine-readable sweep predicate around its
  transition. The persistent per-issue mutex from
  [ADR 0082](0082-persistent-issue-board-mutation-mutex.md) serializes helper
  mutations. General release requires that token and refuses review state or an
  open PR on the claimed branch. The explicit closed-unmerged path releases
  review state only after it proves the stored PR and branch binding. Sweep
  claims name the final worker branch before mutation, so normal review can
  prove that binding without a rebind. The general manual workflow can instead
  use the same-Claim-ID explicit rebind after it creates a PR branch.
- **Workers poll their own long processes in-turn.** The orchestrator holds no
  timers; it re-invokes a worker that has gone quiet.
- **Local resources bound author-check concurrency.** Run at most three ordinary
  check sets at once. Run resource-heavy checks alone while other workers edit.
- **The run stops at READY.** The sweep never merges.

After a human merges a partial-stage sweep PR, the separate issue lifecycle can
move the still-open issue to `needs-grooming` through the explicit stored merged
PR proof. That operator action happens after the sweep has stopped. It does not
grant the sweep merge authority.

## Alternatives considered

**Shared checkout for all workers.** Cheaper to set up and avoids repeated
installs. Rejected: two workers committing from one tree push each other's work,
and a repair applied through the wrong checkout lands on the wrong branch with
nothing to notice it. Isolation is what makes a worker's branch its own.

**Machine-wide author-check scheduling.** Rejected for normal workers. Direct
checks run in isolated checkouts under the sweep's local resource bound. The
legacy coordinator remains only for the diagnostic gate.

**Cron-triggered autonomy.** A sweep that starts itself needs answers this
design does not have: what stops a run burning the usage window unattended, and
who reads a report nobody asked for. Descoped by the operator rather than
deferred; it gets a fresh issue if it is ever wanted.

**Blocking on operator confirmation of the batch.** Rejected: an operator starts
a sweep in order to walk away, and a full ranking run separates their keypress
from the printed batch. The batch is printed with a short abort window instead —
a reviewable audit line, not a consent gate.

## Consequences

A sweep produces finished PRs with their evidence instead of a receipt someone
still has to act on. It runs when an operator starts one, never on a schedule.
The operator's review points are unchanged: they see the batch before it starts
and every PR before anything merges.

Eligibility is deliberately narrower than the ranking that feeds it —
`agent-ready`, exactly one `risk:*` label equal to `risk:low`, a `pkg:*` area,
fit not authority-capped, not blocked, and mutually independent within a batch.
Issues outside that set stay manual, which is the intended cost.

A batch of 4 runs at most three ordinary check sets at once. Heavy checks run
alone while other workers edit. Required CI owns merge admission.

Because the sweep stops at READY, merge approval remains a human step for every
PR it opens.

## Evidence

- PR
  [#2106](https://github.com/mento-protocol/monitoring-monorepo/pull/2106)
  shipped this decision and closes issue
  [#2071](https://github.com/mento-protocol/monitoring-monorepo/issues/2071),
  whose grooming decisions chose the operator-triggered form.
- [`.agents/skills/backlog-sweep/SKILL.md`](../../.agents/skills/backlog-sweep/SKILL.md)
  and its byte-identical `.claude` mirror implement the decision. Operating-card
  step 3 and required CI run the mirror checker and its tests.
- [`docs/notes/backlog-sweep.md`](../notes/backlog-sweep.md) is the canonical
  contract the skill produces against — eligibility, boundaries, resilience
  duties, and the report.
- The skill and canonical backlog-sweep runbook enforce the sweep-local
  resource bound.
- The never-merge boundary rests on the operating card and
  [ADR 0084](0084-github-ui-operator-merge.md). The sweep stops at READY. A
  human can merge through the GitHub UI.

## References

- [`docs/notes/backlog-sweep.md`](../notes/backlog-sweep.md) — the canonical
  loop, boundaries, resilience duties, and report contract.
- [`docs/notes/backlog-ranking.md`](../notes/backlog-ranking.md) — stage 1, the
  receipt, and the exclusion ledger.
- [`docs/notes/pr-operating-card.md`](../notes/pr-operating-card.md) — the PR
  loop every worker runs.
- [ADR 0076](0076-fair-quality-gate-coordinator.md) — the legacy diagnostic
  coordinator, narrowed by M5; normal workers do not use it.
- [ADR 0078](0078-staged-verification-redesign.md) — direct author checks and
  required CI after M5.
