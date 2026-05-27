# ── CI Deploy via Workload Identity Federation ───────────────────────────────
# GitHub Actions workflows from mento-protocol/monitoring-monorepo impersonate
# `metrics-bridge-deployer` via OIDC — no long-lived JSON keys required.
#
# After apply, set two GitHub repo secrets (run from repo root):
#   gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER \
#     --body="$(terraform -chdir=terraform output -raw ci_wif_provider)"
#   gh secret set GCP_SERVICE_ACCOUNT \
#     --body="$(terraform -chdir=terraform output -raw ci_deployer_email)"

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

# Allows the CI deployer SA to mint short-lived tokens for `org-terraform`, the
# seed-project SA used by `alerts/infra/` for both its GCS backend
# (`impersonate_service_account` in `alerts/infra/versions.tf`) and its google
# provider (`alerts/infra/providers.tf`). Without this grant, the CI workflow
# `alerts-infra.yml` fails at `terraform init` with a 403 from STS — the
# deployer SA is authorized via WIF but can't impersonate `org-terraform`.
#
# The binding lives on `org-terraform` in the seed project, NOT in
# `mento-monitoring`. `google_service_account_iam_member` makes the target
# explicit (vs. a project-level binding) so the blast radius is one SA, not
# the whole seed project. `org-terraform` already has the rights it needs in
# the seed project to grant this binding on itself.
resource "google_service_account_iam_member" "ci_alerts_infra_org_terraform_token_creator" {
  # `service_account_id` must use the fully-qualified
  # `projects/<project>/serviceAccounts/<email>` form — the google provider
  # rejects the email-only form at apply-time with a regex validation
  # error, even though `terraform validate` passes both. The project
  # appearing twice (in the path AND embedded in the email) is unavoidable.
  service_account_id = "projects/mento-terraform-seed-ffac/serviceAccounts/${var.terraform_service_account}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"
}

# Same grant for `alerts/rules/` — its GCS backend impersonates `org-terraform`
# (see `alerts/rules/versions.tf`) so `alerts-rules.yml` also needs the CI SA
# to mint tokens for that target. Separate resource (not for_each) so each
# stack's grant can be audited and removed independently.
resource "google_service_account_iam_member" "ci_alerts_rules_org_terraform_token_creator" {
  service_account_id = "projects/mento-terraform-seed-ffac/serviceAccounts/${var.terraform_service_account}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"
}
