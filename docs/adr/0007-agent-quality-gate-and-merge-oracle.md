---
title: Local agent quality gate plus two-projection PR all-clear and Codex gate
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: ci/process
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0007 — Local agent quality gate + two-projection PR all-clear + Codex approval gate

**Status:** Accepted (Apr–Jun 2026), in force.
**Scope:** ci/process

## Context

Agent-authored PRs failed CI in slow, expensive loops, and "is this PR actually
ready?" was answered by eyeballing a noisy checks UI where advisory bots lag the
real status. We needed a cheap local pre-flight and a machine-readable
definition of "ready to merge".

## Decision

Two layers:

- **Local agent quality gate** (`pnpm agent:quality-gate`) maps changed paths to
  the exact package checks + checklists and runs them locally before push. It is
  local-only (never deploys) and refuses to run on package-manifest/lockfile
  changes without explicit review.
- **Hosted all-clear** uses two machine-readable projections in order:
  `pnpm pr:feedback-state` must first report a clean feedback ledger, then
  `pnpm pr:ready-state` is the final required-readiness oracle for current-head
  CI, review gates, and the Codex PR-description gate. Advisory bot lag (for
  example, Cursor) does not block unless branch protection requires it.

## Alternatives considered

- **Trust the GitHub checks UI by eye** — rejected: advisory bots trail the status
  rollup and produce false "not ready" / false "all clear" reads.
- **CI-only, no local gate** — rejected: CI failures are far more expensive than the
  same check run locally in seconds.

## Consequences

- A PR is not clean until `pr:feedback-state` is clean and the subsequent
  current-head `pr:ready-state` result is ready.
- The Codex description gate normally requires a current-head 👍. Only the
  documented, exact-head human break-glass override can replace it; an older
  review cannot.
- Review is a batch-boundary verifier, not the inner edit loop.

## Evidence

- Aggregate CI PR #188; local gate PR #388; shared ready-state PR #508; gate
  wiring PR #818; feedback ledger PR #1037; head-scoped override PR #1044.
- Mechanics in [`docs/notes/agent-quality-gate-mechanics.md`](../notes/agent-quality-gate-mechanics.md) and [`docs/notes/pr-ready-state.md`](../notes/pr-ready-state.md).
