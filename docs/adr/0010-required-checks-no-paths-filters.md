---
title: Required CI checks carry no paths filters; only advisory jobs may
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: ci/process
date: 2026-04
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
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

**Ruleset-required workflows must not use `paths:` or `paths-ignore:` filters.**
They run on every PR and route internally to the relevant work. Advisory,
non-required workflows should use workflow-level path filters when safe. A
workflow whose sticky comment must be cleared when the relevant diff disappears
stays unfiltered and performs its run/skip decision inside the job.

## Alternatives considered

- **`paths:` on required checks to save minutes** — rejected: creates permanently
  pending PRs and unsafe skips on the exact checks that must always report.
- **Mark everything required** — rejected: advisory jobs should stay cheap and
  skippable; the distinction is the point.

## Consequences

- Required package and Terraform-validation routing lives inside the CI sentinel,
  with stack classification backed by `terraform.stacks.json` (ADR 0028).
- Advisory cost is controlled with path filters and Blacksmith runner tuning;
  workflows with cleanup semantics route inside the job instead.

## Evidence

- Path-filter unification PR #176; Blacksmith cost/advisory split PR #813;
  live `main` ruleset verified 2026-07-23.
- Rule in [`docs/pr-checklists/ci-workflow-gates.md`](../pr-checklists/ci-workflow-gates.md); CI model in [`docs/terraform.md`](../terraform.md) §CI Model.
