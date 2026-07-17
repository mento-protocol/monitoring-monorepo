---
title: GitHub Issues are the canonical agent work queue, not BACKLOG.md
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ci/process
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0006 — GitHub Issues are the canonical agent work queue, not `BACKLOG.md`

**Status:** Accepted (May–Jun 2026), in force.
**Scope:** ci/process

## Context

A long-lived `BACKLOG.md` accumulated work items, but agents can't safely _claim_
a markdown bullet: two sessions grab the same line, nothing tracks who's active,
and there's no queryable "what's ready" state. Agent-driven work needs a queue
with atomic claim + state.

## Decision

**GitHub Issues are the canonical active-work queue.** Ready work is
`label:agent-ready`; a helper (`pnpm issue:claim`) atomically flips labels
(`agent-ready` → `agent-active` → `in-pr`) and syncs a workboard. `BACKLOG.md` is
demoted to transition storage only; durable context lives in `AGENTS.md`,
checklists, notes, or tests.

## Alternatives considered

- **Keep `BACKLOG.md` as the queue** — rejected: no atomic claim, no state labels,
  no ownership; duplication between the file and reality goes stale immediately.
- **A third-party project tool** — rejected: Issues already integrate with PRs,
  labels, and the agents' GitHub tooling.

## Consequences

- Queue-state labels are mutually exclusive (`needs-grooming`, `agent-ready`,
  `agent-active`, `in-pr`); an agent runs `issue:claim` before substantive edits.
- Deferrals from a PR must become a labeled issue — the enforcement point for the
  "don't silently drop scope" rule.

## Evidence

- Backlog→Issues migrations PR #662, #673 (2026-05-28); issue workboard helper PR #984 (2026-06-17).
- Lifecycle in [`docs/notes/agent-issue-workflow.md`](../notes/agent-issue-workflow.md); rules in [`AGENTS.md`](../../AGENTS.md).
