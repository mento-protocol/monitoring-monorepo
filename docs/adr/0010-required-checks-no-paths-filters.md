---
title: Required CI checks carry no paths filters; only advisory jobs may
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ci/process
date: 2026-04
---

# ADR 0010 — Required CI checks carry no `paths:` filters; only advisory jobs may

**Status:** Accepted (Apr 2026), in force.
**Scope:** ci/process

## Context

GitHub branch protection waits for a required check to _report_. If that check is
gated by a `paths:` filter, a PR that doesn't touch those paths never runs it, so
the check stays **pending forever** and the PR can never satisfy protection.
`paths:` also has a 300-file cap that silently mis-classifies large PRs.

## Decision

**Required checks (and sticky-comment / security-gate jobs) must not use `paths:`
filters.** They run on every PR via a single required sentinel job that internally
routes to the right per-package work. Advisory, non-required, non-comment
workflows may use `paths:` to save cost.

## Alternatives considered

- **`paths:` on required checks to save minutes** — rejected: creates permanently
  pending PRs and unsafe skips on the exact checks that must always report.
- **Mark everything required** — rejected: advisory jobs should stay cheap and
  skippable; the distinction is the point.

## Consequences

- Terraform/package routing lives inside the sentinel (backed by
  `terraform.stacks.json`, ADR 0028), not in workflow `paths:` YAML.
- Advisory cost is controlled with path filters + Blacksmith runner tuning instead.

## Evidence

- Path-filter unification PR #176; Blacksmith cost/advisory split PR #813.
- Rule in [`docs/pr-checklists/ci-workflow-gates.md`](../pr-checklists/ci-workflow-gates.md); CI model in [`docs/terraform.md`](../terraform.md) §CI Model.
