---
title: Operator-triggered backlog sweep with isolated workers
status: active
owner: eng
canonical: true
last_verified: 2026-08-28
scope: process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0077 — Operator-triggered backlog sweep with isolated workers

**Status:** Accepted (Aug 2026). In force on branches that contain this change.
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

Three constraints shaped the design.

Subagents cannot wait across turns. A subagent that ends its turn to watch a
gate is never re-invoked, so an unattended batch that parks on a gate produces
nothing overnight.

Gate runs are scheduled, not serialized. Since
[ADR 0076](0076-fair-quality-gate-coordinator.md) a transient machine-wide
coordinator admits independent work from different worktrees under a weighted
capacity, and a new gate joins a compatible coordinator instead of queueing
behind it.

Review rounds dominate cost. One shipped PR costs roughly 3% of the weekly
usage window, and each push buys another bot review round whose findings cost
replies and often another push.

## Decision

A sweep is an operator-started session that ranks, picks the eligible top N,
claims each issue by number, and drives each through its own worker to a
ready-for-review PR. It stops at READY and prints the PR links for the operator.

- **The operator starts every run.** No schedule, no self-triggering.
- **The session is an orchestrator.** It runs no gate, edits no source file, and
  opens no PR. It selects, claims, keeps workers moving, and writes the report.
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
- **Concurrency is bounded by the gate coordinator's capacity.** Worker gates
  are scheduled by it and count against it; the batch is capped at 4 and
  defaults to 2.
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

**Machine-wide gate serialization, as the loop was first written.** Rejected
because it no longer describes the gate. Under the coordinator the adopted
`run.lock` names a live pid for as long as anyone on the machine is gating, so
treating that record as a busy signal refuses a sweep in the ordinary case.

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

Bounding concurrency at the coordinator's capacity means a batch of 4 runs at
most three gates at once. Throughput is capped by machine capacity rather than
by how many issues qualify.

Because the sweep stops at READY, merge approval remains a human step for every
PR it opens.

## Evidence

- PR
  [#2106](https://github.com/mento-protocol/monitoring-monorepo/pull/2106)
  shipped this decision and closes issue
  [#2071](https://github.com/mento-protocol/monitoring-monorepo/issues/2071),
  whose grooming decisions chose the operator-triggered form.
- [`.agents/skills/backlog-sweep/SKILL.md`](../../.agents/skills/backlog-sweep/SKILL.md)
  is the procedure that enforces the decision, mirrored byte-identically into
  `.claude/skills/backlog-sweep/SKILL.md`. That mirror is enforced by
  `scripts/repo-health/check-skills-mirror.mjs`, which the Agent Quality Gate
  routes on any change to either tree.
- [`docs/notes/backlog-sweep.md`](../notes/backlog-sweep.md) is the canonical
  contract the skill produces against — eligibility, boundaries, resilience
  duties, and the report.
- The concurrency bound is the gate coordinator's own capacity, default 3,
  recorded in [ADR 0076](0076-fair-quality-gate-coordinator.md) and
  [`docs/notes/agent-quality-gate-mechanics.md`](../notes/agent-quality-gate-mechanics.md).
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
- [ADR 0076](0076-fair-quality-gate-coordinator.md) — the gate coordinator this
  design's concurrency bound depends on.
