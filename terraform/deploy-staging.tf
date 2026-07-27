# Explicit source staging keeps routine deploys off Cloud Build and App
# Engine's project-discovered default buckets. Phase 1 adds these scoped grants
# while the legacy project-wide Storage Admin grants remain available for
# canary deployments; a separate reviewed phase removes those broad grants.

locals {
  deploy_source_callers = setunion(
    toset(var.gcp_dev_members),
    toset(["serviceAccount:${google_service_account.metrics_bridge_deployer.email}"]),
  )
  cloud_build_default_service_account_members = toset([
    for service_account in values(local.grafana_agent_cloudbuild_service_accounts) :
    "serviceAccount:${service_account}"
  ])
  app_engine_source_uploaders = setunion(
    local.deploy_source_callers,
    local.cloud_build_default_service_account_members,
  )
}

# trunk-ignore(checkov/CKV_GCP_62): Cloud Audit Logs cover access; a second log bucket would outlive this reconstructible input.
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

# trunk-ignore(checkov/CKV_GCP_62): Cloud Audit Logs cover access; a second log bucket would outlive this reconstructible input.
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

# Cloud Build's default execution identity depends on project history and
# configuration. Grant both documented candidates read-only source access
# until the deploy canaries identify which one is active.
resource "google_storage_bucket_iam_member" "cloud_build_source_executor_object_viewer" {
  for_each = local.cloud_build_default_service_account_members

  bucket = google_storage_bucket.cloud_build_source_staging.name
  role   = "roles/storage.objectViewer"
  member = each.value
}

# App Engine lists its staging bucket and may replace or clean up hash-named
# cache objects. Keep that write authority on this short-lived source bucket.
resource "google_storage_bucket_iam_member" "app_engine_source_uploader_bucket_reader" {
  for_each = local.app_engine_source_uploaders

  bucket = google_storage_bucket.app_engine_source_staging.name
  role   = "roles/storage.legacyBucketReader"
  member = each.value
}

resource "google_storage_bucket_iam_member" "app_engine_source_uploader_object_admin" {
  for_each = local.app_engine_source_uploaders

  bucket = google_storage_bucket.app_engine_source_staging.name
  role   = "roles/storage.objectAdmin"
  member = each.value
}

resource "google_storage_bucket_iam_member" "app_engine_source_appspot_object_viewer" {
  bucket = google_storage_bucket.app_engine_source_staging.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${local.aegis_app_engine_default_service_account}"
}

# Preserve the routine Metrics Bridge rollout after phase 2 removes the
# project-wide Service Account User grant. Cloud Run uses the project's default
# compute service account because the service does not pin another identity.
resource "google_service_account_iam_member" "ci_default_compute_service_account_user" {
  service_account_id = "projects/${google_project.monitoring.project_id}/serviceAccounts/${google_project.monitoring.number}-compute@developer.gserviceaccount.com"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"

  depends_on = [
    google_project_service.compute,
    google_service_account.metrics_bridge_deployer,
  ]
}
