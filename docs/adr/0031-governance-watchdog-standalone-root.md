---
title: governance-watchdog stays a standalone source root in its own GCP project
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: governance-watchdog
date: 2026-06
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0031 — governance-watchdog stays a standalone source root in its own GCP project

**Status:** Accepted (Jun 2026), in force.
**Scope:** governance-watchdog

## Context

governance-watchdog is a pre-existing Cloud Function that watches Mento Governance
on-chain events and notifies Discord/Telegram. It was brought into the monorepo for
visibility, but it deploys via its own Cloud Build path and runs in its own GCP
project, distinct from the monitoring project.

## Decision

Integrate it as a **standalone source root**: it keeps its **own `pnpm-lock.yaml`**,
its own Cloud Build deploy, and a **dedicated GCP project** (project-factory Terraform
in `governance-watchdog/infra/`). It is not wired into the root workspace build the
way the first-party packages are.

## Alternatives considered

- **Fold it into the root pnpm workspace and shared build** — rejected: it deploys
  through Cloud Build as a standalone function and lives in a different GCP project;
  forcing it into the workspace build buys nothing and risks its lockfile.
- **Leave it in a separate repo** — rejected: co-locating gives shared visibility,
  CI drift detection, and one place to find monitoring code.

## Consequences

- Its lockfile is maintained independently (a range once bumped undici and broke
  Discord delivery; it's pinned exact — see the supply-chain override discipline).
- Its Terraform is a registered stack with CI apply-on-merge + daily drift detection
  under `org-terraform` impersonation (ADR 0028/0029).

## Evidence

- Monorepo integration PR #819 (2026-06-10); undici pin PR #831; stack row in [`docs/terraform.md`](../terraform.md); [`governance-watchdog/README.md`](../../governance-watchdog/README.md).
