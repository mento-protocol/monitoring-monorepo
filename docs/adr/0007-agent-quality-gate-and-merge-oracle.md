---
title: Local agent quality gate plus pr:ready-state merge oracle and Codex gate
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ci/process
date: 2026-05
---

# ADR 0007 — Local agent quality gate + `pr:ready-state` merge oracle + Codex approval gate

**Status:** Accepted (Apr–Jun 2026), in force.
**Scope:** ci/process

## Context

Agent-authored PRs failed CI in slow, expensive loops, and "is this PR actually
ready?" was answered by eyeballing a noisy checks UI where advisory bots lag the
real status. We needed a cheap local pre-flight and a single machine-readable
definition of "ready to merge".

## Decision

Two mechanisms:

- **Local agent quality gate** (`pnpm agent:quality-gate`) maps changed paths to
  the exact package checks + checklists and runs them locally before push. It is
  local-only (never deploys) and refuses to run on package-manifest/lockfile
  changes without explicit review.
- **`pnpm pr:ready-state`** is the **single merge oracle**: required CI green +
  threads resolved + a Codex 👍 on the PR description for the current head. Advisory
  bot lag (e.g. Cursor) does not block unless branch protection requires it.

## Alternatives considered

- **Trust the GitHub checks UI by eye** — rejected: advisory bots trail the status
  rollup and produce false "not ready" / false "all clear" reads.
- **CI-only, no local gate** — rejected: CI failures are far more expensive than the
  same check run locally in seconds.

## Consequences

- A PR is not "clean" until `pr:ready-state` says so _and_ Codex has reacted 👍 on
  the current head; a review on an older commit does not satisfy the gate.
- Review is a batch-boundary verifier, not the inner edit loop.

## Evidence

- Aggregate CI PR #188; ready-state gate wiring PR #818 (2026-06-09).
- Mechanics in [`docs/notes/agent-quality-gate-mechanics.md`](../notes/agent-quality-gate-mechanics.md) and [`docs/notes/pr-ready-state.md`](../notes/pr-ready-state.md).
