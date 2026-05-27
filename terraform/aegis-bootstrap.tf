# ── Aegis App Engine ─────────────────────────────────────────────────────────
# App Engine applications are project-scoped and their location is immutable.
# `mento-monitoring` hosts both the Aegis default service and the grafana-agent
# service so monitoring runtime resources no longer live in `mento-prod`.

resource "google_app_engine_application" "aegis" {
  project     = google_project.monitoring.project_id
  location_id = var.aegis_app_engine_location_id

  depends_on = [google_project_service.appengine]

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  aegis_app_engine_default_service_account = "${google_project.monitoring.project_id}@appspot.gserviceaccount.com"

  grafana_agent_secret_ids = toset([
    "grafana-agent-endpoint",
    "grafana-agent-username",
    "grafana-agent-password",
  ])

  grafana_agent_cloudbuild_service_accounts = {
    legacy  = "${google_project.monitoring.number}@cloudbuild.gserviceaccount.com"
    compute = "${google_project.monitoring.number}-compute@developer.gserviceaccount.com"
  }

  grafana_agent_cloudbuild_project_roles = toset([
    "roles/appengine.appAdmin",
    "roles/artifactregistry.writer",
    "roles/cloudbuild.builds.editor",
    "roles/logging.viewer",
    "roles/storage.admin",
  ])
}

resource "google_secret_manager_secret" "grafana_agent" {
  for_each  = local.grafana_agent_secret_ids
  project   = google_project.monitoring.project_id
  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_iam_member" "grafana_agent_cloudbuild_accessor" {
  for_each  = google_secret_manager_secret.grafana_agent
  project   = google_project.monitoring.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.monitoring.number}@cloudbuild.gserviceaccount.com"

  depends_on = [google_project_service.cloudbuild]
}

resource "google_secret_manager_secret_iam_member" "grafana_agent_cloudbuild_compute_accessor" {
  for_each  = google_secret_manager_secret.grafana_agent
  project   = google_project.monitoring.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.monitoring.number}-compute@developer.gserviceaccount.com"

  depends_on = [
    google_project_service.appengineflex,
    google_project_service.compute,
  ]
}

# App Engine Flex apps run as the App Engine default SA
# (`<project>@appspot.gserviceaccount.com`), not the Compute Engine default
# SA. The metadata server in the application's request context returns the
# AppSpot SA's token, so `grafana-agent/entrypoint.sh` needs THIS binding —
# the Compute SA grant above is preserved for the legacy Cloud Build path
# and other consumers but isn't what authenticates the runtime fetch.
resource "google_secret_manager_secret_iam_member" "grafana_agent_appspot_accessor" {
  for_each  = google_secret_manager_secret.grafana_agent
  project   = google_project.monitoring.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.aegis_app_engine_default_service_account}"

  depends_on = [
    google_project_service.appengineflex,
    google_project_service.secretmanager,
  ]
}

resource "google_project_iam_member" "grafana_agent_cloudbuild_deployer" {
  for_each = {
    for binding in setproduct(keys(local.grafana_agent_cloudbuild_service_accounts), local.grafana_agent_cloudbuild_project_roles) :
    "${binding[0]}:${binding[1]}" => {
      member = "serviceAccount:${local.grafana_agent_cloudbuild_service_accounts[binding[0]]}"
      role   = binding[1]
    }
  }

  project = google_project.monitoring.project_id
  role    = each.value.role
  member  = each.value.member

  depends_on = [
    google_project_iam_member.terraform_owner,
    google_project_service.appengineflex,
    google_project_service.cloudbuild,
    google_project_service.compute,
  ]
}

resource "google_service_account_iam_member" "grafana_agent_cloudbuild_appengine_default_service_account_user" {
  for_each = local.grafana_agent_cloudbuild_service_accounts

  service_account_id = "projects/${google_project.monitoring.project_id}/serviceAccounts/${local.aegis_app_engine_default_service_account}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${each.value}"

  depends_on = [
    google_app_engine_application.aegis,
    google_project_iam_member.grafana_agent_cloudbuild_deployer,
  ]
}
