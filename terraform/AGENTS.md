---
title: Terraform Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-26
doc_type: agent-instructions
scope: terraform
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Terraform

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `terraform/infra`) — read the relevant ADR before changing how something here is built; it records why the code is built that way.

## Scope

`terraform/` is the `platform` stack registered in `terraform.stacks.json`. It manages production infrastructure for the monitoring dashboard, Upstash, the monitoring GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, explicit routine-deploy source buckets, the separated Terraform/service-deploy Workload Identity Federation chains, repo-level GitHub Actions secrets and variables owned by the platform stack, and the dormant, unapplied Peg-policy GCS source foundation. Alloy values are required sensitive, ephemeral operator inputs that terminate at Google provider 6.50.x write-only Secret Manager arguments; only their explicit rotation counters are non-secret. Alert ownership lives in `alerts/` (`alerts/rules/` for protocol Grafana rules, Aegis service/testnet-health rules, and global routing; `alerts/infra/` for event-driven delivery) while `aegis/terraform/` owns the Aegis dashboard and folder.

Alloy's runtime project authority is the custom
`grafanaAgentActivationReader` role with exactly `appengine.services.get` and
`appengine.versions.list`, plus the predefined `roles/logging.logWriter` role
required to start App Engine Flex instances. Do not replace the custom role
with a predefined App Engine viewer role or broaden either boundary; the
active/passive collector handshake depends on this exact read access.

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
  secret payloads. Its description carries Terraform's `gcp_dev_members`
  fingerprint; both operator and builder policies must match it.
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
- Keep routine Cloud Build and App Engine uploads on the explicit buckets and
  scoped roles in
  [`ADR 0053`](../docs/adr/0053-explicit-deployment-source-staging.md). Apply
  this additive bucket/IAM prerequisite from clean current `main`, after its
  infrastructure-only PR merges and with explicit approval. Verify it live
  before merging the routing follow-up for automatic deploy workflows; canary
  all paths before removing broad fallback roles.
- Keep routine deploy, PR plan, trusted-main refresh, and production apply
  identities separate as required by
  [`ADR 0047`](../docs/adr/0047-separated-terraform-ci-identities.md). The
  IaC-owned workflow selectors are
  `vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER`,
  `vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT`,
  `vars.GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER`, and
  `vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`. The four trusted-main plan
  workflows and `terraform-drift.yml` route through the refresh selectors.
  Routing is live, and run
  [#30212385280](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/30212385280)
  completed the full-refresh proof. The legacy-authority removal, run drain,
  and final IAM/WIF audit are complete.
- Build trusted-main refresh access from curated non-basic project read roles;
  never use basic `roles/viewer`. Keep Secret Accessor limited to the exact
  Terraform-managed secrets and Storage Object Viewer limited to state and
  deployment-source buckets. Treat service data exposed by predefined readers
  (including logs, metrics, and artifacts) as part of the confidentiality
  review. The merged `main` route completed full-refresh, unlocked plans for
  every CI-managed Google-provider stack. Add only an exact missing permission
  named by a provider denial.
- The Peg-policy foundation remains source-only until a separate reviewed,
  human-approved platform plan and apply. It creates no policy object and does
  not attach the runtime identity to Cloud Run. Peg-policy access logs are audit
  telemetry, never an authorization control; audit effective readers on both
  buckets before activation.

## Verification

Run `pnpm tf validate platform`. Apply `docs/pr-checklists/terraform-cloudrun.md` for Cloud Run or deploy-adjacent changes. For alert-rule or alert-infra changes, see `docs/terraform.md`, `alerts/rules/README.md`, and `alerts/infra/README.md`.
