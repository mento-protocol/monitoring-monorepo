---
title: Terraform Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-11
doc_type: agent-instructions
scope: terraform
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Terraform

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `terraform/infra`) — read the relevant ADR before changing how something here is built; it records why the code is built that way.

## Scope

`terraform/` is the `platform` stack registered in `terraform.stacks.json`. It
manages the monitoring dashboard, Upstash, the monitoring GCP project and APIs,
private Peg-policy storage, Metrics Bridge Cloud Run shape, Aegis App
Engine/Grafana Alloy bootstrap, deploy source buckets, the separated
Terraform/service-deploy Workload Identity Federation chains, and repo-level
GitHub Actions secrets and variables. Alerts live elsewhere: `alerts/rules/`
owns protocol and Aegis Grafana rules plus global routing, `alerts/infra/` owns
event-driven delivery, and `aegis/terraform/` owns the Aegis dashboard and
folder.

Alloy values are sensitive, ephemeral operator inputs that terminate at Google
provider 6.50.x write-only Secret Manager arguments; only their rotation
counters are non-secret. Alloy's runtime authority is the custom
`grafanaAgentActivationReader` role, `roles/logging.logWriter`, and
repository-scoped `roles/artifactregistry.reader` on the Terraform-managed
`us.gcr.io` repository. Never widen those to project-wide Artifact Registry or
predefined App Engine viewer access; the active/passive collector handshake and
image pull depend on the exact boundaries.

## Operating Rules

- Use `pnpm tf list` to confirm stack ownership before moving resources.
- Run `pnpm infra:plan` or `pnpm tf plan platform` before any apply. After
  explicit human approval, run
  `pnpm infra:apply -- -auto-approve` or
  `pnpm tf apply platform -- -auto-approve`; never run raw platform
  `terraform apply`.
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
  tfvars stay outside that committed snapshot. [ADR 0061](../docs/adr/0061-exact-plan-guard-for-manual-platform-applies.md)
  owns the private exact-plan, variable snapshot, and argument boundary; never
  bypass the wrapper or supply a caller-owned plan.
- Alloy deploy operators receive the metadata-only
  `grafanaAgentPreflightReader` custom role: enough for the mandatory live
  preflight, never enough to read secret payloads. Its description carries
  Terraform's `gcp_dev_members` fingerprint; operator and builder policies must
  match it.
- Never set GitHub Actions, Vercel, GCP Secret Manager, Upstash, Grafana, or
  other platform secrets manually with CLI commands. Secrets owned by this stack
  must be modeled as Terraform variables/resources and delivered by a
  human-approved plan/apply. If Terraform cannot manage a secret yet, add the
  missing IaC path or ask for direction; never reach for `gh secret set`,
  `vercel env add`, or an equivalent workaround.
- Resource address renames need `moved` blocks. To retire a state-managed
  resource without destroying its remote counterpart, use a `removed` block
  with an explicit `destroy` choice.
- Keep the Alloy `us.gcr.io` repository state-managed with `prevent_destroy`.
- Cloud Run services use `/health`, not `/healthz`.
- For deploy-owned Cloud Run images, retain the necessary
  `lifecycle.ignore_changes` for the image and provider bookkeeping drift. In
  steady state, also ignore the generated revision name. Before any
  Terraform-owned template change (env, probes, resources, service account, or
  template scaling), set `metrics_bridge_template_rollout_active = true` and
  remove only the revision ignore in the same PR. After the approved apply and
  runtime proof, use a separate stabilization PR to restore the marker to
  `false` and the revision ignore. Pause unrelated platform applies while the
  marker is `true`. If apply or proof fails, inspect live state and either
  complete or explicitly roll back the template change before stabilization;
  never restore the ignore over a pending template change. The platform plan
  checker enforces the selected mode against the actual saved plan, including
  variable-file-driven template changes.
- Project-level IAM changes must be ordered behind required bootstrap/API enablement dependencies.
- Keep routine Cloud Build and App Engine uploads on the explicit buckets and
  scoped roles in
  [`ADR 0053`](../docs/adr/0053-explicit-deployment-source-staging.md). The
  default AppSpot service account may receive Storage Admin only on its
  service-owned `staging.<project>.appspot.com` bucket; never grant it at
  project scope or on either Terraform-managed source bucket. The
  Metrics Bridge builder migration in
  [`ADR 0058`](../docs/adr/0058-metrics-bridge-dedicated-cloud-build-executor.md)
  has an applied, verified IAM foundation, and the checked-in build config pins
  the dedicated builder. Both route canaries passed. Keep direct Cloud Build
  source-object reads limited to the Alloy and Metrics Bridge builders; never
  reintroduce default Compute's direct bucket Object Viewer. Routine Metrics
  Bridge deploys must target the two dedicated reader instances, never their
  whole `for_each` collection, so only a reviewed full platform apply can enact
  a pending sibling removal. Default Compute's project-level Editor role
  remains a separate audit and retirement task.
- Keep routine deploy, PR plan, trusted-main refresh, and production apply
  identities separate as required by
  [`ADR 0047`](../docs/adr/0047-separated-terraform-ci-identities.md). Policy
  publication selects its dedicated plan account; the other trusted-main
  workflows select the shared refresh account, whose WIF binding must list only
  those five regular workflow refs. A pool-wide main-ref binding would let
  publication bypass its dedicated chain.
- Build trusted-main refresh access from curated non-basic project read roles;
  never basic `roles/viewer`. Keep Secret Accessor limited to the exact
  Terraform-managed secrets and Storage Object Viewer to state and
  deployment-source buckets, and count the service data predefined readers
  expose — logs, metrics, artifacts — as part of the confidentiality review.
  Add only an exact missing permission named by a provider denial.
- Peg policy: the runtime attachment pins the current generation as a reviewed
  source literal and the Grafana consumers are live. Grafana rule changes take
  the ordinary plan → approved-apply path; `peg-thresholds.json` rollovers
  instead go through the manual protected `Peg Policy Publication` workflow and
  a separate reviewed platform change that re-pins the generation
  ([`docs/deployment.md`](../docs/deployment.md)). Never retain a
  project-level controller grant or broad Storage Admin, Storage Object Admin,
  or Service Account User fallbacks. The routine deployer and `gcp_dev_members`
  receive Service Account User only on the Metrics Bridge runtime identity and
  dedicated builder, never on default Compute. An approved,
  time-bounded emergency bootstrap may grant only `pegPolicyBucketController` at
  project level until both policies reconcile; remove it immediately, verify its
  absence, and run a clean full plan. Terraform derives the pinned GCS URL and
  `gcp-metadata` mode together from the
  reviewed generation literal; never supply a URL or auth-mode variable. See
  [`docs/terraform.md`](../docs/terraform.md),
  [ADR 0054](../docs/adr/0054-same-project-peg-policy-artifact.md), and
  [ADR 0055](../docs/adr/0055-peg-policy-bucket-controller-recovery.md).
- Access logs are audit telemetry, never an authorization control.

## Verification

Run `pnpm tf validate platform`. Apply `docs/pr-checklists/terraform-cloudrun.md` for Cloud Run or deploy-adjacent changes. For alert-rule or alert-infra changes, see `docs/terraform.md`, `alerts/rules/README.md`, and `alerts/infra/README.md`.
