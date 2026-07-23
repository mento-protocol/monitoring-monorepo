---
title: Terraform Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: agent-instructions
scope: terraform
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Terraform

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `terraform/infra`) — read the relevant ADR before changing how something here is built; it records why the code is built that way.

## Scope

`terraform/` is the `platform` stack registered in `terraform.stacks.json`. It manages production infrastructure for the monitoring dashboard, Upstash, the monitoring GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, Workload Identity Federation, and repo-level GitHub Actions secrets and variables owned by the platform stack. Alert ownership lives in `alerts/` (`alerts/rules/` for protocol Grafana rules, Aegis service/testnet-health rules, and global routing; `alerts/infra/` for event-driven delivery) while `aegis/terraform/` owns the Aegis dashboard and folder.

## Operating Rules

- Use `pnpm tf list` to confirm stack ownership before moving resources.
- Run `pnpm infra:plan` or `pnpm tf plan platform` before any apply.
- Never run `terraform apply` without explicit human approval.
- Never set GitHub Actions, Vercel, GCP Secret Manager, Upstash, Grafana, or
  other platform secrets manually with CLI commands. Secrets owned by this stack
  must be modeled as Terraform variables/resources and delivered by a
  human-approved plan/apply. If Terraform cannot manage the secret yet, add the
  missing IaC path or ask for direction; do not use `gh secret set`,
  `vercel env add`, or equivalent as an agent workaround.
- Resource address renames need `moved` blocks. To retire a state-managed
  resource without destroying its remote counterpart, use a `removed` block
  with an explicit `destroy` choice.
- Cloud Run services use `/health`, not `/healthz`.
- For deploy-owned Cloud Run images, retain the necessary
  `lifecycle.ignore_changes` for the image and provider bookkeeping drift. If a
  change alters Terraform-owned template shape (env, probes, resources, or
  template scaling), re-audit or remove `template[0].revision` for that PR.
- Project-level IAM changes must be ordered behind required bootstrap/API enablement dependencies.

## Verification

Run `pnpm tf validate platform`. Apply `docs/pr-checklists/terraform-cloudrun.md` for Cloud Run or deploy-adjacent changes. For alert-rule or alert-infra changes, see `docs/terraform.md`, `alerts/rules/README.md`, and `alerts/infra/README.md`.
