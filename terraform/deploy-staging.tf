# Explicit source staging keeps routine deploys off Cloud Build and App
# Engine's project-discovered default buckets. The buckets and existing scoped
# grants are live, and the former project-wide storage and act-as fallbacks are
# gone. ADR 0058's dedicated Metrics Bridge builder is applied and routed. This
# stack removes default Compute's direct source-bucket Object Viewer; its
# project-level Editor role remains a separate audit and retirement task.

locals {
  deploy_source_callers = setunion(
    toset(var.gcp_dev_members),
    toset(["serviceAccount:${google_service_account.metrics_bridge_deployer.email}"]),
  )

  # Both Cloud Build routes pin dedicated executors. Keep direct source-object
  # reads limited to those two identities.
  cloud_build_source_executor_members = toset([
    "serviceAccount:${google_service_account.grafana_agent_builder.email}",
    "serviceAccount:${google_service_account.metrics_bridge_builder.email}",
  ])

  # App Engine source access remains separate from Cloud Build source access.
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

# The Alloy and Metrics Bridge Cloud Build configurations pin dedicated
# executors. Keep their direct source access read-only and exact.
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

# App Engine still writes its service-owned staging.<project>.appspot.com
# bucket after gcloud routes source input through the explicit bucket above.
# Keep Google's required default-service-account grant on that bucket.
resource "google_storage_bucket_iam_member" "app_engine_default_staging_admin" {
  bucket = "staging.${google_project.monitoring.project_id}.appspot.com"
  role   = "roles/storage.admin"
  member = "serviceAccount:${local.aegis_app_engine_default_service_account}"

  depends_on = [google_app_engine_application.aegis]
}

# The gcloud caller submits CreateVersion before App Engine takes over. Grant
# the same uploader set access to only the service-owned staging bucket; the
# AppSpot-only grant above does not let these callers complete that submission.
resource "google_storage_bucket_iam_member" "app_engine_default_staging_uploader_admin" {
  for_each = local.app_engine_source_uploaders

  bucket = "staging.${google_project.monitoring.project_id}.appspot.com"
  role   = "roles/storage.admin"
  member = each.value

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

# The applied phase-one foundation grants submitters act-as only on the
# dedicated build executor now pinned by cloudbuild.yaml. Do not grant
# default-Compute Service Account User.
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
