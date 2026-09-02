---
title: Architectural decisions are recorded as ADRs, enforced by a reminder gate
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
scope: ci/process
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0033 — Architectural decisions are recorded as ADRs, enforced by a reminder gate

**Status:** Accepted (Jul 2026), amended by M3 and M5 in 2026-09. The reminder
now runs in the existing required root-scripts CI job. Direct author checks
also route control-plane changes to the focused contract.
**Scope:** ci/process

## Context

The repo's architecture was carried only in people's heads and in scattered
AGENTS.md rules, so onboarding humans and agents re-litigated settled decisions
or violated them without knowing a decision existed. ADRs 0001–0032 captured the
backlog of past decisions — but a static log rots: new decisions get made in PRs
and never recorded, and "we should write that down" is the first thing a busy
session drops.

## Decision

Architectural decisions are recorded as ADRs under `docs/adr/`, and the process
is enforced, not just documented:

- **When** to write one is defined by a three-part test and a trigger-surface
  list in [`docs/pr-checklists/architecture-decisions.md`](../pr-checklists/architecture-decisions.md).
- **A reminder check** — `scripts/pr/check-adr-reminder.mjs` (`pnpm adr:check`) —
  detects high-signal architectural changes (new package/service, new Terraform
  stack, new CI/deploy workflow) that ship without an ADR and prints a reminder.
  The required `Lint + test root scripts` CI job runs it and its tests. The
  operating card requires it for the same high-signal surfaces during author
  checks.
- **The PR template** asks "Architecture decision?" so authors consciously
  answer yes (link the ADR) or no (why).

The gate is **advisory by default** and silent when no trigger is present. When
a trigger is present, it prints either a missing-ADR reminder or a lighter
coverage prompt if the change includes an ADR; `--strict` exits non-zero only
for a trigger without an accompanying ADR.

## Alternatives considered

- **Docs-only ("please remember to write ADRs")** — rejected: unenforced process
  rots; the whole point is that the reminder is impossible to forget.
- **Hard-block every PR touching an architectural path** — rejected: most such
  PRs are threshold tweaks or reorders, not decisions; false positives would
  train everyone to ignore the gate. Advisory + self-suppressing keeps the signal
  credible, with `--strict` available when a team opts in.
- **A dedicated CI context** — rejected: the existing required root-scripts job
  runs the reminder without adding another required context. The PR-template
  prompt retains the explicit author decision.

## Consequences

- Adding a new package, Terraform stack, or workflow without an ADR triggers a
  visible reminder; when no ADR is needed, record a one-line reason on the PR's
  **Architecture decision?** checklist item.
- ADRs are canonical context (ADR 0005), so each is enrolled in the 90-day
  re-verification check — the log stays honest over time.
- `pnpm adr:check` is a repo command; `scripts/pr/check-adr-reminder.test.mjs`
  covers its trigger logic.

## Evidence

- `scripts/pr/check-adr-reminder.mjs`, `scripts/pr/check-adr-reminder.test.mjs`,
  `docs/pr-checklists/architecture-decisions.md`, the `adr:check` script in
  `package.json`, the `terraform.stacks.json` / workspace / workflow routing in
  `scripts/agent-quality-gate.sh`, and the "Architecture decision?" line in
  `.github/pull_request_template.md`.
