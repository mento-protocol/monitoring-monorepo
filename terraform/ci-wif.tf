# ── CI Deploy via Workload Identity Federation ───────────────────────────────
# GitHub Actions workflows from mento-protocol/monitoring-monorepo impersonate
# `metrics-bridge-deployer` (write-capable) for apply jobs and the new
# `metrics-bridge-plan-readonly` SA for plan jobs. Both via OIDC — no
# long-lived JSON keys required. The plan/apply split limits the blast
# radius of a malicious PR adding a plan-time `external` or `local-exec`
# data source to exfiltrate context.
#
# After apply, set three GitHub repo secrets (run from repo root):
#   gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER \
#     --body="$(terraform -chdir=terraform output -raw ci_wif_provider)"
#   gh secret set GCP_SERVICE_ACCOUNT \
#     --body="$(terraform -chdir=terraform output -raw ci_deployer_email)"
#   gh secret set GCP_SERVICE_ACCOUNT_PLAN \
#     --body="$(terraform -chdir=terraform output -raw ci_plan_readonly_email)"
#
# The seed-project `org-terraform-plan-readonly@` SA is now managed by
# terraform (see `org_terraform_plan_readonly` resource below) — no manual
# gcloud bootstrap step required. Apply ordering inside one `pnpm infra:apply`:
#   1. `google_service_account.org_terraform_plan_readonly` (created in seed)
#   2. `google_storage_bucket_iam_member.state_bucket_plan_readonly` (grants
#      objectViewer on the state bucket)
#   3. `google_service_account_iam_member.ci_plan_readonly_*_token_creator`
#      (binds the new CI SA as tokenCreator on the new seed SA)
#
# The google provider in this stack impersonates `org-terraform@seed` (see
# providers.tf). For the SA-create + state-bucket binding to land, the
# `org-terraform` SA must have `iam.serviceAccountAdmin` on the seed
# project and `storage.admin` on the state bucket. Both are existing perms
# (`org-terraform` already manages other resources in seed) — if apply 403s
# on this resource, the failure tells us which role is missing.
#
# WORKFLOW-PR NOTE (`storage.objectViewer` + state locking):
#   `roles/storage.objectViewer` lets the plan SA read state but NOT
#   create/delete the lock object that the GCS backend acquires by
#   default. The follow-up workflow PR must therefore pass `-lock=false`
#   to plan jobs (already documented in BACKLOG.md). Apply jobs stay on
#   the write-capable deployer SA which keeps locking on. This trade-off
#   intentionally chooses strict-least-privilege for plan over speculative
#   lock contention — plan jobs are short and re-run on each push, so a
#   skipped lock can't drop work the way a missed apply could.

resource "google_iam_workload_identity_pool" "github_actions" {
  project                   = google_project.monitoring.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  description               = "Federation pool for mento-protocol GitHub Actions workflows"

  depends_on = [google_project_service.iam]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.monitoring.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"

  # Attribute condition gates which OIDC tokens are accepted. Restrict to the
  # monitoring-monorepo repo so other mento-protocol repos can't use this pool
  # to impersonate our deployer SA.
  attribute_condition = "attribute.repository == \"mento-protocol/monitoring-monorepo\""

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "metrics_bridge_deployer" {
  project      = google_project.monitoring.project_id
  account_id   = "metrics-bridge-deployer"
  display_name = "metrics-bridge CI deployer"
  description  = "Impersonated by GitHub Actions via WIF to deploy the bridge"

  depends_on = [google_project_service.iam]
}

# Any workflow in the repo can impersonate the deployer SA. Tighten later by
# swapping principalSet → principal with a workflow-ref attribute mapping.
resource "google_service_account_iam_member" "deployer_wif_binding" {
  service_account_id = google_service_account.metrics_bridge_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.repository/mento-protocol/monitoring-monorepo"
}

# Project-level grants the CI SA needs for the full deploy flow:
#   - cloudbuild.builds.editor  → submit Cloud Build jobs
#   - storage.admin             → `gcloud builds submit` runs a project-wide
#                                 `storage.buckets.list` probe before upload
#                                 to resolve the default `<project>_cloudbuild`
#                                 staging bucket. storage.admin grants list +
#                                 object-write; scoping to one bucket doesn't
#                                 work because the probe is project-scoped.
#                                 Root cause of every failed bridge deploy
#                                 since PR #206 (misleading "bucket forbidden
#                                 / serviceusage.services.use" error —
#                                 PR #216 tried the CLI's suggested role, it
#                                 didn't work; this PR replaces it with the
#                                 permissions actually exercised by the CLI).
#                                 Broader than strictly needed — the CI SA
#                                 could manage any GCS bucket in the project.
#                                 Acceptable because `mento-monitoring` is a
#                                 single-tenant project (only metrics-bridge
#                                 lives here; Vercel + Upstash are off-project,
#                                 Artifact Registry is covered by
#                                 `artifactregistry.writer` separately).
#                                 Tighten to a custom role if this project
#                                 ever hosts sensitive GCS data.
#   - logging.viewer            → stream Cloud Build logs back to the runner
#                                 so `gcloud builds submit` blocks until the
#                                 build finishes (otherwise it exits with
#                                 "can only stream logs if you are Viewer").
#                                 Pair with `options.logging: CLOUD_LOGGING_ONLY`
#                                 in cloudbuild.yaml so logs land in Cloud
#                                 Logging (not the default GCS log bucket).
#   - artifactregistry.writer   → push images to AR
#   - run.admin                 → update the Cloud Run service revision
#   - iam.serviceAccountUser    → "act-as" the runtime SA used by Cloud Run
locals {
  ci_deployer_roles = [
    "roles/cloudbuild.builds.editor",
    "roles/storage.admin",
    "roles/logging.viewer",
    "roles/artifactregistry.writer",
    "roles/run.admin",
    "roles/appengine.appAdmin",
    "roles/iam.serviceAccountUser",
  ]
}

resource "google_project_iam_member" "ci_deployer" {
  for_each = toset(local.ci_deployer_roles)
  project  = google_project.monitoring.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_service_account_iam_member" "ci_appengine_default_service_account_user" {
  service_account_id = "projects/${google_project.monitoring.project_id}/serviceAccounts/${local.aegis_app_engine_default_service_account}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"

  depends_on = [
    google_app_engine_application.aegis,
    google_project_iam_member.ci_deployer,
  ]
}

# Allows the CI deployer SA to mint short-lived tokens for `org-terraform`,
# the seed-project SA used by `alerts/infra/`, `alerts/rules/`, AND
# `aegis/terraform/` for their GCS backend impersonation (and, for
# `alerts/infra/`, also its google provider). Without this grant,
# `alerts-infra.yml` / `alerts-rules.yml` / `aegis-terraform.yml` fail at
# `terraform init` with a 403 from STS — the deployer SA is authorized via
# WIF but can't impersonate `org-terraform`.
#
# `google_service_account_iam_member` is keyed on the (service_account_id,
# role, member) triple — one Terraform resource per triple, not per
# consumer. A second resource with the same triple wouldn't create a second
# binding; it would shadow this one, and removing either would revoke the
# underlying grant and break BOTH stacks until the next apply. So this
# single resource covers every CI stack that impersonates `org-terraform`.
#
# The binding lives on `org-terraform` in the seed project, NOT in
# `mento-monitoring`. `google_service_account_iam_member` makes the target
# explicit (vs. a project-level binding) so the blast radius is one SA, not
# the whole seed project. `org-terraform` already has the rights it needs in
# the seed project to grant this binding on itself.
resource "google_service_account_iam_member" "ci_alerts_org_terraform_token_creator" {
  # `service_account_id` must use the fully-qualified
  # `projects/<project>/serviceAccounts/<email>` form — the google provider
  # rejects the email-only form at apply-time with a regex validation
  # error, even though `terraform validate` passes both. The project
  # appearing twice (in the path AND embedded in the email) is unavoidable.
  service_account_id = "projects/mento-terraform-seed-ffac/serviceAccounts/${var.terraform_service_account}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"
}

# Rename from `ci_alerts_infra_...` once `alerts/rules/` joined `alerts/infra/`
# as a second consumer of the same impersonation grant. `moved` lets `apply`
# pick up the rename without destroying and re-creating the underlying IAM
# binding (which would leave a brief window where both stacks 403). Safe to
# remove this block after one full apply cycle has propagated the move.
moved {
  from = google_service_account_iam_member.ci_alerts_infra_org_terraform_token_creator
  to   = google_service_account_iam_member.ci_alerts_org_terraform_token_creator
}

# ── Read-only Plan SA ────────────────────────────────────────────────────────
# Plan-time hardening: PR plan jobs use a separate, read-only identity so a
# malicious PR adding a plan-time data source (e.g. `external`, `local-exec`,
# or a custom data source that shells out) can't mint tokens for the write-
# capable `metrics-bridge-deployer` SA. Apply jobs continue to use the
# deployer SA on main pushes.
#
# This hardening reduces SA-chain blast radius. It does NOT mitigate
# `TF_VAR_*` cleartext exposure at plan time — providers still need those
# secrets to refresh upstream state. That mitigation lives in the
# `pull_request.head.repo.fork == false` guard in each workflow.
resource "google_service_account" "metrics_bridge_plan_readonly" {
  project      = google_project.monitoring.project_id
  account_id   = "metrics-bridge-plan-readonly"
  display_name = "Terraform CI plan (read-only)"
  description  = "Impersonated by GitHub Actions PR plan jobs. Has no project-level write roles; only impersonates the read-only seed SA to refresh state."

  depends_on = [google_project_service.iam]
}

# Same WIF binding shape as `deployer_wif_binding` above — the GitHub repo
# is the upstream gate. Same "tighten later by swapping principalSet → principal
# with a workflow-ref attribute mapping" note applies here; revisit alongside
# the deployer-binding tightening.
resource "google_service_account_iam_member" "plan_readonly_wif_binding" {
  service_account_id = google_service_account.metrics_bridge_plan_readonly.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.repository/mento-protocol/monitoring-monorepo"
}

# The seed-project SA that the plan-readonly CI SA impersonates. Created
# in the `mento-terraform-seed-ffac` seed project (not `mento-monitoring`),
# so this resource overrides the provider's default project. No project-level
# roles granted — only `roles/storage.objectViewer` on the state bucket,
# scoped via the resource binding below.
resource "google_service_account" "org_terraform_plan_readonly" {
  project      = "mento-terraform-seed-ffac"
  account_id   = "org-terraform-plan-readonly"
  display_name = "Org Terraform (plan-readonly)"
  description  = "Read-only impersonation target for CI plan jobs; sibling of org-terraform with state-bucket read access only."
}

# State-bucket read access for the plan-readonly seed SA. `objectViewer` is
# sufficient for `terraform plan` because plan jobs pass `-lock=false` (see
# WORKFLOW-PR NOTE in the file header — the GCS backend's lock-object
# create/delete requires `objectAdmin`, which we deliberately don't grant).
resource "google_storage_bucket_iam_member" "state_bucket_plan_readonly" {
  bucket = "mento-terraform-tfstate-6ed6"
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.org_terraform_plan_readonly.email}"
}

# Grants the plan-readonly CI SA the ability to mint tokens for the
# `org-terraform-plan-readonly@seed` SA (read-only sibling of `org-terraform`).
resource "google_service_account_iam_member" "ci_plan_readonly_org_terraform_plan_readonly_token_creator" {
  service_account_id = google_service_account.org_terraform_plan_readonly.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.metrics_bridge_plan_readonly.email}"
}
