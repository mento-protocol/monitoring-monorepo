---
title: Supply-chain hardening — release-age gate, lockfile-lint, SHA-pinned Actions
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

# ADR 0009 — Supply-chain hardening: release-age gate, lockfile-lint, SHA-pinned Actions

**Status:** Accepted (Apr–Jun 2026), in force.
**Scope:** ci/process

## Context

A monitoring system that watches money is a supply-chain target. Two attack
vectors matter most here: a freshly published malicious package version pulled in
by a range, and a mutated GitHub Action tag executing arbitrary code in CI.

## Decision

Adopt a defense-in-depth posture:

- **`minimumReleaseAge`** in `pnpm-workspace.yaml` refuses registry versions
  younger than 3 days. `@mento-protocol/*` and narrow, reviewed security
  releases may bypass the delay; frozen-lockfile installs verify new entries
  against the same policy.
- **`pnpm lockfile:lint`** fails closed when invoked and validates lockfile
  integrity, registry provenance, and bounded override/resolution floors with
  no install needed. The advisory Supply Chain workflow runs it on dependency
  inputs and daily.
- **SHA-pin every GitHub Action** `uses:` ref, enforced by the ruleset-required
  Code Quality job through `scripts/check-github-action-pins.mjs`.

## Alternatives considered

- **Trust the registry and tags** — rejected: tag mutation and same-day malicious
  releases are real, cheap attacks against exactly this kind of repo.
- **Manual vigilance** — rejected: unenforced posture rots; each control is a gate.

## Consequences

- Override ranges re-resolve on fresh lockfiles, so migrations pin exact versions
  (a range once silently bumped undici and broke Discord delivery).
- An advisory pruning report keeps `pnpm.overrides` + release-age exclusions honest.

## Evidence

- `minimumReleaseAge` PR #418; lockfile-lint PR #447; advisory workflow split
  PR #813; enforce-pinned-actions PR #922; early action pins PR #177.
- Guards in `pnpm-workspace.yaml`, `scripts/check-github-action-pins.mjs`, [`docs/pr-checklists/recurring-review-patterns.md`](../pr-checklists/recurring-review-patterns.md).
