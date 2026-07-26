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

`terraform/` is the `platform` stack registered in `terraform.stacks.json`. It manages production infrastructure for the monitoring dashboard, Upstash, the monitoring GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, the separated Terraform/service-deploy Workload Identity Federation chains, and repo-level GitHub Actions secrets and variables owned by the platform stack. Alloy values are required sensitive, ephemeral operator inputs that terminate at the pinned Google provider's write-only Secret Manager arguments; only their explicit rotation counters are non-secret. Alert ownership lives in `alerts/` (`alerts/rules/` for protocol Grafana rules, Aegis service/testnet-health rules, and global routing; `alerts/infra/` for event-driven delivery) while `aegis/terraform/` owns the Aegis dashboard and folder.

Alloy's runtime project authority is the custom
`grafanaAgentActivationReader` role with exactly `appengine.services.get` and
`appengine.versions.list`. Do not replace it with a predefined App Engine
viewer role or broaden it; the active/passive collector handshake depends on
this exact read boundary.

## Operating Rules

- Use `pnpm tf list` to confirm stack ownership before moving resources.
- Run `pnpm infra:plan` or `pnpm tf plan platform` before any apply.
- Never run `terraform apply` without explicit human approval.
- Platform plan/apply must run with `TF_LOG`, `TF_LOG_CORE`,
  `TF_LOG_PROVIDER`, every `TF_LOG_PROVIDER_*`, `TF_LOG_SDK`, and
  `TF_LOG_SDK_PROTO` unset or `OFF`. Every other `TF_LOG_SDK_*`, including
  `TF_LOG_SDK_PROTO_DATA_DIR`, must be unset or empty; `OFF` is a directory name
  there and does not disable protocol dumps. `TF_LOG_PATH` alone does not
  enable logs and remains allowed. Platform plan and apply must use a clean
  `main` checkout whose HEAD matches freshly fetched `origin/main`;
  `--force-local-apply` does not bypass this secret-input guard. The wrapper
  executes the verified commit from a temporary source snapshot; gitignored
  tfvars stay external and are passed by absolute file path.
- Alloy deploy operators receive the exact metadata-only
  `grafanaAgentPreflightReader` custom role so the mandatory live preflight can
  inspect IAM, secret metadata, runtime identity, and traffic without reading
  secret payloads. Keep its permissions and `gcp_dev_members` binding exact.
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
- Keep routine deploy, PR plan, trusted-main refresh, and production apply
  identities separate as required by
  [`ADR 0047`](../docs/adr/0047-separated-terraform-ci-identities.md). The
  IaC-owned workflow selectors are
  `vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER`,
  `vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT`,
  `vars.GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER`, and
  `vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`. The four trusted-main plan
  workflows and `terraform-drift.yml` route through the refresh selectors.
  Keep the legacy Token Creator rollback grant until live proof, drain checks,
  and the separate authority-removal change are complete.
- Build trusted-main refresh access from curated non-basic project read roles;
  never use basic `roles/viewer`. Keep Secret Accessor limited to the exact
  Terraform-managed secrets and Storage Object Viewer limited to state and
  deployment-source buckets. Treat service data exposed by predefined readers
  (including logs, metrics, and artifacts) as part of the confidentiality
  review. The routing is checked in, but live proof is still required through
  the merged `main` route: run full-refresh, unlocked plans for every
  CI-managed Google-provider stack and add only the exact missing permission
  named by a provider denial. Drain and audit those runs before authority
  removal.
- Only a separate final removal PR may delete the routine deployer's
  `org-terraform` Token Creator grant, and only through an explicitly approved
  platform apply. Do not create the peg-policy project or bucket until that
  removal is applied, all queued and active runs drain, and the final IAM audit
  confirms the old path is gone.

## Verification

Run `pnpm tf validate platform`. Apply `docs/pr-checklists/terraform-cloudrun.md` for Cloud Run or deploy-adjacent changes. For alert-rule or alert-infra changes, see `docs/terraform.md`, `alerts/rules/README.md`, and `alerts/infra/README.md`.
