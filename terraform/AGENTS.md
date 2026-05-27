---
title: Terraform Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# AGENTS.md — Terraform

## Scope

`terraform/` is the `platform` stack registered in `terraform.stacks.json`. It manages production infrastructure for the monitoring dashboard, Upstash, the monitoring GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Agent bootstrap, and Workload Identity Federation. Alert ownership lives in `alerts/` (`alerts/rules/` for protocol Grafana rules/global routing, `alerts/infra/` for event-driven delivery) and `aegis/terraform/` (Aegis dashboard + service-health alert).

## Operating Rules

- Use `pnpm tf list` to confirm stack ownership before moving resources.
- Run `pnpm infra:plan` or `pnpm tf plan platform` before any apply.
- Never run `terraform apply` without explicit human approval.
- Resource renames/removals need `moved` blocks.
- Cloud Run services use `/health`, not `/healthz`.
- Keep `lifecycle.ignore_changes` for images and Cloud Run API bookkeeping fields when rollouts happen through deploy scripts or workflows.
- Project-level IAM changes must be ordered behind required bootstrap/API enablement dependencies.

## Verification

Run `pnpm tf validate platform`. Apply `docs/pr-checklists/terraform-cloudrun.md` for Cloud Run or deploy-adjacent changes. For alert-rule or alert-infra changes, see `docs/terraform.md`, `alerts/rules/README.md`, and `alerts/infra/README.md`.
