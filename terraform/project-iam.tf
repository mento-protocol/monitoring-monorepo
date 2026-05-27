# ── Dev Team IAM ─────────────────────────────────────────────────────────────
# Gives devs the ability to deploy new revisions, push images, and submit builds.
# All depend on `terraform_owner` so the impersonated SA has project-level
# setIamPolicy rights before TF schedules these bindings on a cold bootstrap.

resource "google_project_iam_member" "dev_run_admin" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/run.admin"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_iam_member" "dev_ar_writer" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/artifactregistry.writer"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_iam_member" "dev_cloudbuild_editor" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/cloudbuild.builds.editor"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_iam_member" "dev_storage_admin" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/storage.admin"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_project_iam_member" "dev_appengine_admin" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/appengine.appAdmin"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}

resource "google_service_account_iam_member" "dev_appengine_default_service_account_user" {
  for_each = toset(var.gcp_dev_members)

  service_account_id = "projects/${google_project.monitoring.project_id}/serviceAccounts/${local.aegis_app_engine_default_service_account}"
  role               = "roles/iam.serviceAccountUser"
  member             = each.value

  depends_on = [
    google_app_engine_application.aegis,
    google_project_iam_member.dev_appengine_admin,
  ]
}

# cloudbuild.yaml pins `options.logging: CLOUD_LOGGING_ONLY` so both CI and
# `scripts/deploy-bridge.sh` stream logs from Cloud Logging (not the default
# GCS log bucket). Devs need `logging.viewer` to read those streams — without
# it, `pnpm bridge:deploy` runs the build but fails at log-stream time.
# Mirrors the same role on `ci_deployer_roles`.
resource "google_project_iam_member" "dev_logging_viewer" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/logging.viewer"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}
