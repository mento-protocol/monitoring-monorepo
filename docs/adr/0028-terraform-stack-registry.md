---
title: Terraform ownership is a registry with roots split by cadence and blast radius
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: terraform/infra
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0028 — Terraform ownership is a registry (`terraform.stacks.json`) with roots split by cadence

**Status:** Accepted (May 2026), in force.
**Scope:** terraform/infra

## Context

Infrastructure spans the dashboard platform, alert rules, event-driven alert
delivery, Aegis dashboards, and governance-watchdog — each a different provider,
change cadence, and blast radius. Inferring stack ownership from directory names is
error-prone (a bare `TF_VAR` in one workflow once clobbered a same-named sibling
stack's variable), and a single mega-state couples unrelated changes.

## Decision

Register every Terraform root in a machine-readable **`terraform.stacks.json`**
(path, state prefix, ownership, plan/apply policy) and keep **separate roots with
separate GCS state**, split by cadence and blast radius: `platform`, `alerts-rules`
(daily), `alerts-delivery` (monthly), `aegis`, `governance-watchdog`. CI and scripts
ask the registry which stacks changed; ownership is never inferred from directory
names.

## Alternatives considered

- **One monolithic Terraform state** — rejected: couples daily alert-threshold edits
  to rare platform changes; one bad plan risks everything.
- **Directory-name ownership convention** — rejected: not machine-checkable and
  already caused a cross-stack variable clobber.

## Consequences

- Cross-stack resource moves are import-then-`state rm` (state can't cross backends),
  as done for the Aegis service-health rule group move into `alerts-rules`.
- The registry is authoritative for ownership and changed-stack
  classification. Coarse workflow admission filters and the required CI
  sentinel still duplicate path coverage until issue #1501 replaces that
  duplication with enforced parity.

## Evidence

- Stack ownership refactor PR #603 (2026-05-27); current registry in
  [`terraform.stacks.json`](../../terraform.stacks.json), classifier in
  [`scripts/tf-stacks.mjs`](../../scripts/tf-stacks.mjs), and routing limits in
  [`docs/terraform.md`](../terraform.md).
