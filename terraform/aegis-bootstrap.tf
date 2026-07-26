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

  grafana_agent_builder_project_roles = toset([
    "roles/appengine.deployer",
    "roles/artifactregistry.writer",
    "roles/cloudbuild.builds.editor",
    "roles/logging.logWriter",
    "roles/storage.objectAdmin",
  ])

  grafana_agent_secret_ids_by_key = {
    for secret_id in local.grafana_agent_secret_ids :
    trimprefix(secret_id, "grafana-agent-") => secret_id
  }
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

# The three secret payloads enter Terraform through one sensitive ephemeral
# object and terminate at this provider write-only argument. Only the reviewed
# non-secret counters persist in configuration/state and trigger rotation.
resource "google_secret_manager_secret_version" "grafana_agent" {
  for_each = local.grafana_agent_secret_ids_by_key

  secret                 = google_secret_manager_secret.grafana_agent[each.value].id
  secret_data_wo         = var.grafana_agent_secret_values[each.key]
  secret_data_wo_version = var.grafana_agent_secret_rotation_counters[each.key]
  deletion_policy        = "DISABLE"

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_service_account" "grafana_agent_runtime" {
  project      = google_project.monitoring.project_id
  account_id   = "grafana-agent-runtime"
  display_name = "Grafana Alloy App Engine runtime"
  description  = "Least-privilege runtime identity for the grafana-agent App Engine service."

  depends_on = [
    google_project_iam_member.terraform_owner,
    google_project_service.iam,
  ]
}

resource "google_service_account" "grafana_agent_builder" {
  project      = google_project.monitoring.project_id
  account_id   = "grafana-agent-builder"
  display_name = "Grafana Alloy Cloud Build deployer"
  description  = "Dedicated least-privilege Cloud Build identity for deploying zero-traffic grafana-agent versions."

  depends_on = [
    google_project_iam_member.terraform_owner,
    google_project_service.iam,
  ]
}

resource "google_secret_manager_secret_iam_member" "grafana_agent_runtime_accessor" {
  for_each  = local.grafana_agent_secret_ids_by_key
  project   = google_project.monitoring.project_id
  secret_id = google_secret_manager_secret.grafana_agent[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.grafana_agent_runtime.email}"
}

resource "google_project_iam_custom_role" "grafana_agent_activation_reader" {
  project     = google_project.monitoring.project_id
  role_id     = "grafanaAgentActivationReader"
  title       = "Grafana Agent Activation Reader"
  description = "Allows Alloy to read its traffic split and prove every other collector version stopped."
  permissions = [
    "appengine.services.get",
    "appengine.versions.list",
  ]

  depends_on = [google_project_service.appengineflex]
}

resource "google_project_iam_member" "grafana_agent_runtime_activation_reader" {
  project = google_project.monitoring.project_id
  role    = google_project_iam_custom_role.grafana_agent_activation_reader.name
  member  = "serviceAccount:${google_service_account.grafana_agent_runtime.email}"

  depends_on = [google_project_iam_custom_role.grafana_agent_activation_reader]
}

resource "google_project_iam_custom_role" "grafana_agent_preflight_reader" {
  project     = google_project.monitoring.project_id
  role_id     = "grafanaAgentPreflightReader"
  title       = "Grafana Agent Preflight Reader"
  description = "Allows deploy operators to verify the exact Alloy IAM, secret metadata, runtime identity, and traffic contract without reading secret payloads."
  permissions = [
    "appengine.applications.get",
    "appengine.services.get",
    "appengine.versions.get",
    "iam.roles.get",
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.getIamPolicy",
    "resourcemanager.projects.get",
    "resourcemanager.projects.getIamPolicy",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.list",
    "secretmanager.versions.get",
  ]

  depends_on = [
    google_project_service.appengineflex,
    google_project_service.iam,
    google_project_service.secretmanager,
  ]
}

resource "google_project_iam_member" "grafana_agent_operator_preflight_reader" {
  for_each = toset(var.gcp_dev_members)

  project = google_project.monitoring.project_id
  role    = google_project_iam_custom_role.grafana_agent_preflight_reader.name
  member  = each.value

  depends_on = [
    google_project_iam_custom_role.grafana_agent_preflight_reader,
  ]
}

# Phase A rollback only. Cloud Build does not need secret payloads for the new
# pinned runtime path. Retain these legacy accessors until the dedicated
# identity is live and verified; Phase C removes every unproven grant.
resource "google_secret_manager_secret_iam_member" "grafana_agent_cloudbuild_accessor" {
  for_each  = google_secret_manager_secret.grafana_agent
  project   = google_project.monitoring.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.monitoring.number}@cloudbuild.gserviceaccount.com"

  depends_on = [google_project_service.cloudbuild]
}

# Phase A rollback only. See the legacy-access note above.
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

# Phase A rollback only. Previously deployed versions can still run as AppSpot;
# keep their payload access until the new pinned version passes live proof and
# the rollback window closes. Phase C removes this grant separately.
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
  for_each = local.grafana_agent_builder_project_roles

  project = google_project.monitoring.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.grafana_agent_builder.email}"

  depends_on = [
    google_project_iam_member.terraform_owner,
    google_project_service.appengineflex,
    google_project_service.cloudbuild,
    google_project_service.compute,
  ]
}

resource "google_service_account_iam_member" "grafana_agent_builder_submitter" {
  for_each = toset(var.gcp_dev_members)

  service_account_id = google_service_account.grafana_agent_builder.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value
}

resource "google_service_account_iam_member" "grafana_agent_cloudbuild_runtime_service_account_user" {
  service_account_id = google_service_account.grafana_agent_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.grafana_agent_builder.email}"

  depends_on = [
    google_project_iam_member.grafana_agent_cloudbuild_deployer,
  ]
}
