---
title: Infra applies on merge to main behind the production-infra environment gate
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: terraform/infra
date: 2026-05
---

# ADR 0029 — Infra applies on merge to `main` behind the `production-infra` environment gate

**Status:** Accepted (May–Jun 2026), in force.
**Scope:** terraform/infra

## Context

Manual `terraform apply` from laptops is unauditable and drifts from what's in the
repo. For a sole-maintainer workflow we still want a human approval step and a
recorded deploy history, without requiring a second person for routine service
rollouts.

## Decision

Terraform stacks with CI-apply policy (`alerts-rules`, `alerts-delivery`, `aegis`,
`governance-watchdog`) **apply on merge to `main`**, gated by the **`production-infra`
GitHub Environment** (required reviewer, self-review allowed, admin bypass disabled,
branch restricted to protected `main`). PR runs do **read-only plans** under a
read-only plan service account. The `platform` stack stays manual-plan/manual-apply.
Routine service deploys use a separate `production-services` environment that records
history but doesn't require manual approval.

## Alternatives considered

- **Manual applies only** — rejected: unauditable, drift-prone, and not agent-runnable.
- **Auto-apply with no approval** — rejected: production infra needs a human gate;
  the environment's required-reviewer + self-review setting satisfies it for one
  maintainer.

## Consequences

- Local `pnpm tf apply` on CI-applied stacks is guarded (clean `main` at
  `origin/main`, or the deliberate `--force-local-apply`).
- The deployer's Workload Identity Federation is ref-gated to `refs/heads/main`
  (non-`main` refs 403); worktrees lack `terraform.tfvars`, so run TF from `main`.
- Agents never apply without explicit human approval; plan first, surface the diff.

## Evidence

- Alerts-infra CI plan/apply PR #558 (2026-05-26); governance-watchdog CI apply PR #1001; environment split issue #762.
- CI model + environment setup in [`docs/terraform.md`](../terraform.md).
