# Explicit source staging keeps routine deploys off Cloud Build and App
# Engine's project-discovered default buckets. The buckets and existing scoped
# grants are live, and the former project-wide storage and act-as fallbacks are
# gone. ADR 0058 adds the Metrics Bridge builder here before a separate routing
# change selects it.

locals {
  deploy_source_callers = setunion(
    toset(var.gcp_dev_members),
    toset(["serviceAccount:${google_service_account.metrics_bridge_deployer.email}"]),
  )

  # Alloy pins its Cloud Build executor to grafana_agent_builder. Phase 1 adds
  # Metrics Bridge's dedicated builder alongside the current default Compute
  # executor. Keep both Object Viewer grants until the later routing PR pins
  # the new identity and its canaries pass; this apply must not change the live
  # build route.
  cloud_build_source_executor_members = toset([
    "serviceAccount:${google_service_account.grafana_agent_builder.email}",
    "serviceAccount:${google_project.monitoring.number}-compute@developer.gserviceaccount.com",
    "serviceAccount:${google_service_account.metrics_bridge_builder.email}",
  ])

  # Metrics Bridge's default Compute executor has no App Engine deploy path.
  # Keep its archive read authority out of the App Engine source bucket.
  app_engine_source_uploaders = setunion(
    local.deploy_source_callers,
    toset(["serviceAccount:${google_service_account.grafana_agent_builder.email}"]),
  )
}

# trunk-ignore(checkov/CKV_GCP_62): Short-lived, reconstructible deploy input does not justify a separate access-log bucket that outlives it.
# trunk-ignore(checkov/CKV_GCP_78): unique build archives come from source control and expire quickly, so old object versions add cost without recovery value.
resource "google_storage_bucket" "cloud_build_source_staging" {
  project                     = google_project.monitoring.project_id
  name                        = "${google_project.monitoring.project_id}-cloud-build-source"
  location                    = var.gcp_region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Build archives are reconstructible and use unique object names. Delete
  # live archives quickly and disable soft-delete retention so deletion does
  # not create a second, billable retention tail.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age        = 7
      with_state = "LIVE"
    }
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.storage]
}

# trunk-ignore(checkov/CKV_GCP_62): Short-lived, reconstructible deploy input does not justify a separate access-log bucket that outlives it.
# trunk-ignore(checkov/CKV_GCP_78): content-addressed cache objects come from source control and expire quickly, so old versions add no recovery value.
resource "google_storage_bucket" "app_engine_source_staging" {
  project                     = google_project.monitoring.project_id
  name                        = "${google_project.monitoring.project_id}-app-engine-source"
  location                    = "US"
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # App Engine addresses cached source files by content hash, so keep a short
  # reuse window. The source is reconstructible; soft-delete retention would
  # only extend storage after the live-object lifecycle removes it.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age        = 30
      with_state = "LIVE"
    }
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.storage]
}

# `gcloud builds submit --gcs-source-staging-dir` reads bucket metadata and
# creates a uniquely named archive. It does not need overwrite or delete.
resource "google_storage_bucket_iam_member" "cloud_build_source_caller_bucket_reader" {
  for_each = local.deploy_source_callers

  bucket = google_storage_bucket.cloud_build_source_staging.name
  role   = "roles/storage.legacyBucketReader"
  member = each.value
}

resource "google_storage_bucket_iam_member" "cloud_build_source_caller_object_creator" {
  for_each = local.deploy_source_callers

  bucket = google_storage_bucket.cloud_build_source_staging.name
  role   = "roles/storage.objectCreator"
  member = each.value
}

# The Alloy rollout pins its executor to the dedicated builder identity. Metrics
# Bridge's verified executor is the project's default Compute service account.
# Give both read-only access to the explicit source bucket before the routing
# follow-up directs their build submissions there.
resource "google_storage_bucket_iam_member" "cloud_build_source_executor_object_viewer" {
  for_each = local.cloud_build_source_executor_members

  bucket = google_storage_bucket.cloud_build_source_staging.name
  role   = "roles/storage.objectViewer"
  member = each.value

  depends_on = [
    google_project_service.cloudbuild,
    google_project_service.compute,
  ]
}

# App Engine lists its staging bucket and may replace or clean up hash-named
# cache objects. Keep that write authority on this short-lived source bucket.
resource "google_storage_bucket_iam_member" "app_engine_source_uploader_bucket_reader" {
  for_each = local.app_engine_source_uploaders

  bucket = google_storage_bucket.app_engine_source_staging.name
  role   = "roles/storage.legacyBucketReader"
  member = each.value

  depends_on = [
    google_project_service.cloudbuild,
    google_project_service.compute,
  ]
}

resource "google_storage_bucket_iam_member" "app_engine_source_uploader_object_admin" {
  for_each = local.app_engine_source_uploaders

  bucket = google_storage_bucket.app_engine_source_staging.name
  role   = "roles/storage.objectAdmin"
  member = each.value

  depends_on = [
    google_project_service.cloudbuild,
    google_project_service.compute,
  ]
}

resource "google_storage_bucket_iam_member" "app_engine_source_appspot_object_viewer" {
  bucket = google_storage_bucket.app_engine_source_staging.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${local.aegis_app_engine_default_service_account}"

  depends_on = [google_app_engine_application.aegis]
}

# Cloud Run pins the dedicated Metrics Bridge runtime identity, so the deployer
# can act as that service account without project-wide Service Account User.
resource "google_service_account_iam_member" "ci_metrics_bridge_runtime_service_account_user" {
  service_account_id = google_service_account.metrics_bridge_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"

  depends_on = [
    google_service_account.metrics_bridge_deployer,
    google_service_account.metrics_bridge_runtime,
  ]
}

# `pnpm bridge:deploy` is a supported direct Cloud Run deployment path. Devs
# already have Run Admin; bind Service Account User only on the dedicated
# runtime identity so that path keeps working after the broad fallback is
# removed.
resource "google_service_account_iam_member" "dev_metrics_bridge_runtime_service_account_user" {
  for_each = toset(var.gcp_dev_members)

  service_account_id = google_service_account.metrics_bridge_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value

  depends_on = [
    google_project_iam_member.dev_run_admin,
    google_service_account.metrics_bridge_runtime,
  ]
}

# Phase 1 grants submitters act-as only on the future dedicated build executor.
# Current Metrics Bridge submits still use the default Compute executor until a
# later reviewed routing change updates cloudbuild.yaml after this foundation's
# approved current-main apply. Do not grant default-Compute Service Account User.
resource "google_service_account_iam_member" "ci_metrics_bridge_builder_service_account_user" {
  service_account_id = google_service_account.metrics_bridge_builder.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"

  depends_on = [
    google_service_account.metrics_bridge_builder,
    google_service_account.metrics_bridge_deployer,
  ]
}

resource "google_service_account_iam_member" "dev_metrics_bridge_builder_service_account_user" {
  for_each = toset(var.gcp_dev_members)

  service_account_id = google_service_account.metrics_bridge_builder.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value

  depends_on = [google_service_account.metrics_bridge_builder]
}

# The target account changes as well as the resource names, so Terraform plans
# the required replacement instead of treating these scoped grants as unrelated
# additions and removals.
moved {
  from = google_service_account_iam_member.ci_default_compute_service_account_user
  to   = google_service_account_iam_member.ci_metrics_bridge_runtime_service_account_user
}

moved {
  from = google_service_account_iam_member.dev_default_compute_service_account_user
  to   = google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user
}
