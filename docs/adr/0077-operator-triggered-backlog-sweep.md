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

## Amendment — 2026-09: the sweep grooms its own queue

The first operator-triggered sweep (2026-09-01) claimed nothing. Of 18 open
`agent-ready` issues, none carried `risk:low` beside exactly one `pkg:*`, and
nine engineering issues carried no queue-state label at all, so ranking counted
them outside the queue. The Consequences section below prices narrow
eligibility as "the intended cost". That price assumed the labels already
existed. Neither stage of the loop writes them, so the delivered throughput was
zero rather than low.

Two additions, neither of which changes the decision above. Eligibility keeps
every clause it had, the sweep still stops at READY, and it still never merges.

**A grooming pass inside the sweep.** It runs after the batch is claimed and
every worker is spawned, and before the report — including on an empty batch,
which is the case it exists for. It reads each candidate's body and the paths
that body names, applies `pkg:*`, `kind:*`, and a narrowing `risk:*` from what
the tree holds, posts one `sweep-groomed:v1` marker comment per issue, and is
capped at 10 candidates a run. Its position in the loop is one safety property:
this run's eligibility step has already finished, so no label the pass writes
can select work for this run. Grooming first and then selecting was the
alternative, and it is one night faster; it was rejected because it lets one
unattended session grant itself `risk:low` and immediately work the issue,
which is the root [`AGENTS.md`](../../AGENTS.md) rule against weakening a
control that blocks your own work, applied to the sweep's own gate.

**Ordering alone was not enough, so the pass never writes a label that leaves an
issue sweep-eligible, and never writes a state label.** A run boundary plus a
passive veto still ends with the same agent population treating its own label as
authorization twelve hours later, on an issue no human read. The rule is stated
against the eligibility predicate rather than against a list of labels, because
which label completes it depends on what the issue already carries: for an issue
holding `risk:low` and no package area it is the `pkg:*`; for one holding a
package area and no risk label it is the `risk:low`. Narrowing labels —
`risk:medium`, `risk:high`, several `pkg:*` areas — are written freely. Anything
that would complete the predicate goes in the marker's `proposed` list with the
rule clause behind it, and one human label supplies the acknowledgement that
ordering cannot. State labels are withheld for a different reason:
[ADR 0082](0082-persistent-issue-board-mutation-mutex.md) serializes queue-state
writes behind the per-issue mutex, `gh issue edit` does not take it, and a raw
write against a roster snapshot can land `needs-grooming` beside an
`agent-active` a claim added moments earlier. Both stay proposals an operator or
a mutex-owning helper applies. The cost is that repairing the queue completely
still needs one human pass; the pass removes the labeling work, not the
judgement.

The marker also carries a 12-hour veto window. An issue a sweep groomed is
ineligible until it closes, which gives a human a bounded chance to disagree
with an agent's label before that label picks work for another agent. Only a
sweep writes the marker, so hand-labeling is never delayed. The accepted cost
is that fast-tracking a sweep-groomed issue means waiting the window out or
deleting the marker comment.

The marker is written before the labels, on every issue. The comment and the
label edit are separate API calls, so an ordering exists either way, and only
this one fails safe: a label that landed with no marker is selectable at once,
while a marker with no labels is an issue the next run will not pick and the
report explains. When the comment cannot be posted the pass writes no label for
that issue at all.

The marker is a comment, so eligibility reads it as untrusted input. The window
is measured from GitHub's `createdAt` rather than the timestamp inside the
payload, and a marker counts only from an author who can set labels — the
account the sweep authenticates as, or a login whose repository role is
`triage` or above. `authorAssociation` was rejected for that second test: it
names a relationship rather than a permission level, so a read-only outside
collaborator reads as `COLLABORATOR`. Without both rules the veto is a queue
denial-of-service, where any issue participant parks a real issue out of the
queue by re-posting the public marker format or extends its window with a
future timestamp.

**A path test for `pkg:tooling` independence.** The batch rule "no two issues
share a `pkg:*` label" assumes a label maps to a collision surface. It does for
`pkg:indexer` and `pkg:dashboard`. `pkg:tooling` spans `scripts/`, `docs/`,
`.agents/`, `.claude/`, and root tooling, so it refuses unrelated pairs. Two
`pkg:tooling` candidates are now independent when each body names its expected
files, no path either names equals or contains a path the other names, and
neither names a shared root file or control root. Containment rather than a
fixed-depth prefix, because `docs/` and `docs/notes/` differ at every prefix
length yet overlap on every file. The mirrored skill trees normalize to one
path first, since the mirror check makes every edit land in both; that
normalization is by path segment, so it does not depend on how a body happens
to spell a directory. A candidate
with no path list conflicts with every other. The refinement is scoped to that
one label; every other area keeps the label test. `pnpm issue:claim
--sweep-eligible` enforces neither form and needs no change: it grades one
issue's own labels and never sees the batch, so batch independence stays the
orchestrator's judgement in both shapes.

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
Issues outside that set stay manual, which is the intended cost. The amendment
above adds the pass that keeps that set from being empty, and bounds the delay
it introduces at 12 hours per groomed issue.

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
- Issue
  [#2209](https://github.com/mento-protocol/monitoring-monorepo/issues/2209)
  carries the 2026-09 amendment: the grooming pass, its veto window, and the
  `pkg:tooling` path test, all documented in the two files above.
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
