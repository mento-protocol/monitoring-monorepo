---
title: Terraform Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# AGENTS.md — Terraform

## Scope

`terraform/` manages production infrastructure for the monitoring dashboard, Cloud Run services, and Workload Identity Federation. Alert rules live in `alerts/` (`alerts/rules/` for Grafana metric alerts, `alerts/infra/` for event-driven delivery).

## Operating Rules

- Run `pnpm infra:plan` or the matching module plan before any apply.
- Never run `terraform apply` without explicit human approval.
- Resource renames/removals need `moved` blocks.
- Cloud Run services use `/health`, not `/healthz`.
- Keep `lifecycle.ignore_changes` for images when rollouts happen through deploy scripts or workflows.
- Project-level IAM changes must be ordered behind required bootstrap/API enablement dependencies.

## Verification

Run Terraform fmt/init/validate for `terraform`. Apply `docs/pr-checklists/terraform-cloudrun.md` for Cloud Run or deploy-adjacent changes. For alert-rule or alert-infra changes, see `alerts/rules/README.md` and `alerts/infra/README.md`.
