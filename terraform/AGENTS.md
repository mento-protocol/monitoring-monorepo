---
title: Terraform Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-29
doc_type: agent-instructions
scope: terraform
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Terraform

Read the relevant [`terraform/infra` ADR](../docs/adr/README.md) before changing
this stack's architecture.

## Scope

`terraform/` is the `platform` stack registered in `terraform.stacks.json`. It
manages the monitoring dashboard, the dashboard's read-only Grafana service
account and token, Upstash, the monitoring GCP project and APIs, private
Peg-policy storage, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana
Alloy bootstrap, deploy source buckets, the separated Terraform/service-deploy
Workload Identity Federation chains, repo-level GitHub Actions settings, the
Team-only main lifecycle ruleset, and the source-gated local-agent App broker
secret bootstrap.
Core ruleset `13494367` remains unmanaged. Alerts live elsewhere:
`alerts/rules/` owns protocol and Aegis
Grafana rules plus global routing, `alerts/infra/` owns event-driven delivery,
and `aegis/terraform/` owns the Aegis dashboard and folder.

Alloy secrets use ephemeral inputs and write-only Secret Manager fields. Only
rotation counters are non-secret. Its runtime roles are
`grafanaAgentActivationReader`, `roles/logging.logWriter`, and repository-scoped
`roles/artifactregistry.reader` on `us.gcr.io`. Do not widen them; the collector
handshake and image pull depend on these boundaries.

## Operating Rules

- Use `pnpm tf list` to confirm stack ownership before moving resources.
- Run `pnpm infra:plan` or `pnpm tf plan platform` before any apply. After
  explicit human approval, run
  `pnpm infra:apply -- -auto-approve` or
  `pnpm tf apply platform -- -auto-approve`; never run raw platform
  `terraform apply`.
- Platform plan/apply permits `TF_LOG_PATH` alone. Keep other `TF_LOG*` controls
  unset or `OFF` and SDK data directories empty. It requires clean `main` at
  freshly fetched `origin/main`; `--force-local-apply` cannot bypass this guard.
  The wrapper executes a committed snapshot and keeps gitignored tfvars outside
  it. It rejects caller `TF_CLI_CONFIG_FILE` and `TF_REATTACH_PROVIDERS`, and
  owns the private CLI configuration. ADR 0061 owns the exact plan, variable
  snapshot, provider runtime, and argument boundary. Never bypass it or supply a
  caller plan.
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
- ADR 0078 owns the human merge boundary. Keep all three lifecycle rules
  Team-only in `pull_request` mode and core ruleset `13494367` unmanaged. Source
  pins the repository, Team, rule ID, enforcement, audit, broker-scaffold gate,
  partial-recovery gate, and broker impersonator; never move this authority to
  a tfvar or repository variable. Keep the scaffold gate false until the
  separate Phase 4 source approval. Keep the recovery gate false except for the
  reviewed create/no-op recovery of a failed Phase 4 apply. Keep
  provider targets fixed, Secret Manager write-only, and stronger credentials
  off agent OSes. Parse and exercise the App RSA key only from the exact
  unindented HCL heredoc in the wrapper's private tfvars copy. Reject JSON key
  assignments. The runbook owns custody, approvals, recovery, cutover, proof,
  and rotation.
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
- Order project IAM changes after required bootstrap and API enablement.
- Keep Cloud Build and App Engine uploads on the explicit buckets and scoped
  roles in [`ADR 0053`](../docs/adr/0053-explicit-deployment-source-staging.md).
  The
  App Engine uploaders and default AppSpot service account may receive Storage
  Admin only on the service-owned `staging.<project>.appspot.com` bucket; never
  grant them at project scope or on either Terraform-managed source bucket. The
  Metrics Bridge builder in
  [`ADR 0058`](../docs/adr/0058-metrics-bridge-dedicated-cloud-build-executor.md)
  has verified IAM and a pinned build config. Keep direct Cloud Build
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
- The Grafana provider here mints only the dashboard's read-only identity in
  `grafana-read-access.tf`. Keep it on `Viewer`, add no Grafana rules or
  dashboards, keep the Admin `grafana_provisioning_token` out of every secret
  sink, and rotate the minted token by counter plus redeploy — never
  `-replace`, never the console, and never apply without the redeploy.
  [ADR 0063](../docs/adr/0063-dashboard-grafana-history-read-access.md).
- Access logs are audit telemetry, never an authorization control.

## Verification

Run `pnpm tf validate platform` and `pnpm tf:test`. Boundary changes also need
their focused plan and drift suites. Use the Cloud Run checklist for
deploy-adjacent changes. Alert work follows `docs/terraform.md` and the alert
package READMEs.
