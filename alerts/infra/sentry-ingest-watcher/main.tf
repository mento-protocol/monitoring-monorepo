##################
# Cloud Function #
##################

resource "terraform_data" "cloudbuild_builder_dependency" {
  input = var.cloudbuild_builder_dependency
}

# CKV_GCP_124: ALLOW_ALL ingress is required for Cloud Scheduler HTTP targets;
# invocation is still restricted to the scheduler service account via OIDC IAM.
# trunk-ignore(checkov/CKV_GCP_124)
resource "google_cloudfunctions2_function" "sentry_ingest_watcher" {
  project     = var.project_id
  name        = var.function_name
  description = "Publishes seconds since the Sentry triage ingest last recorded work on its tracker issue, as a Cloud Monitoring gauge"
  location    = var.region

  labels = var.common_labels

  build_config {
    runtime         = var.runtime
    entry_point     = "handleSentryIngestFreshness"
    service_account = "projects/${var.project_id}/serviceAccounts/${var.project_service_account_email}"
    source {
      storage_source {
        bucket = google_storage_bucket.function_bucket.name
        object = google_storage_bucket_object.function_source.name
      }
    }
  }

  service_config {
    available_memory                 = "${var.memory_mb}M"
    timeout_seconds                  = var.timeout_seconds
    max_instance_count               = var.max_instances
    max_instance_request_concurrency = 1
    min_instance_count               = var.min_instances
    service_account_email            = google_service_account.function_runtime.email
    environment_variables            = local.environment_variables
    ingress_settings                 = "ALLOW_ALL"
    all_traffic_on_latest_revision   = true
  }

  lifecycle {
    ignore_changes = [
      labels["deployment-tool"],
      labels["goog-terraform-provisioned"],
      service_config[0].environment_variables
    ]

    replace_triggered_by = [
      google_storage_bucket_object.function_source
    ]
  }

  depends_on = [
    terraform_data.cloudbuild_builder_dependency,
    google_project_iam_member.runtime_metric_writer,
    google_storage_bucket_iam_member.cloud_build_storage_access,
  ]

  timeouts {
    create = "15m"
    update = "15m"
    delete = "10m"
  }
}

############################################
# Cloud Storage bucket for function source #
############################################

# trunk-ignore(checkov/CKV_GCP_62): bucket stores only the function source zip
resource "google_storage_bucket" "function_bucket" {
  project  = var.project_id
  name     = "${var.project_id}-sentry-ingest-watcher-source-${random_id.bucket_suffix.hex}"
  location = var.region

  uniform_bucket_level_access = true
  force_destroy               = true
  public_access_prevention    = "enforced"

  labels = var.common_labels

  versioning {
    enabled = true
  }

  # Same rule and rationale as governance-watchdog/infra/storage.tf, which is
  # where this repo worked the problem out after 41 archives had piled up.
  # A source change renames the object (the name embeds the hash), so
  # Terraform replaces it — and with versioning on, the replaced generation
  # becomes noncurrent rather than going away. Expire by age of that
  # noncurrent time, never by `num_newer_versions`: unique names mean no
  # generation ever gains newer versions under itself, so a count condition
  # would never fire. 30 days is the rollback window. The live object the
  # deployed revision was built from is never ARCHIVED and always survives,
  # so this cannot introduce plan churn.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      with_state                 = "ARCHIVED"
      days_since_noncurrent_time = 30
    }
  }

  # No `prevent_destroy`, matching all three existing function source buckets
  # in this repo (onchain-event-handler, oncall-announcer, and the
  # governance-watchdog one above). These archives are derived artifacts:
  # `data.archive_file` rebuilds them from git on every apply, so a destroyed
  # bucket costs a re-upload, not data. Guarding it would also contradict the
  # rule directly above — the same generations cannot be disposable after 30
  # days and undestroyable at the same time — and would leave this the only
  # module in the stack that blocks teardown. `prevent_destroy` here is
  # reserved for irreplaceable state: the GCP project, the published peg
  # policy generations, and the Alloy image repository.
  lifecycle {
    prevent_destroy = false
    ignore_changes  = [labels["goog-terraform-provisioned"]]
  }
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

data "archive_file" "function_source" {
  type        = "zip"
  source_dir  = path.module
  output_path = "${path.module}/function-source.zip"
  excludes = [
    "node_modules",
    "coverage",
    "coverage/**",
    ".git",
    "**/*.test.mjs",
    "main.tf",
    "locals.tf",
    "variables.tf",
    "outputs.tf",
    "versions.tf",
    "README.md",
    ".terraform",
    "**/*.tfstate",
    "**/*.tfstate.backup",
    "**/*.tfvars",
    "**/*.tfvars.json",
    ".env",
    ".env.*",
    "function-source.zip"
  ]
  output_file_mode = "0644"
}

resource "google_storage_bucket_object" "function_source" {
  name           = "sentry-ingest-watcher-${local.source_hash}.zip"
  bucket         = google_storage_bucket.function_bucket.name
  source         = data.archive_file.function_source.output_path
  detect_md5hash = data.archive_file.function_source.output_md5

  lifecycle {
    ignore_changes = [
      content_type,
      metadata,
    ]
  }
}

#####################
# Cloud Build IAM   #
#####################

resource "google_storage_bucket_iam_member" "cloud_build_storage_access" {
  bucket = google_storage_bucket.function_bucket.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${var.project_service_account_email}"
}

# Terraform's storage-object Read path fetches the managed source object.
resource "google_storage_bucket_iam_member" "terraform_refresh_readonly_function_source" {
  bucket = google_storage_bucket.function_bucket.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}

###################
# Runtime IAM     #
###################

resource "google_service_account" "function_runtime" {
  project      = var.project_id
  account_id   = "sentry-ingest-watcher-rt"
  display_name = "Sentry Ingest Watcher Runtime"
  description  = "Runtime identity for the sentry-ingest-watcher Cloud Function. Writes one custom metric; holds no GitHub credential because the GitHub read is unauthenticated."
}

# The only permission this watcher needs. It reads GitHub anonymously and its
# sole write is the freshness gauge.
resource "google_project_iam_member" "runtime_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.function_runtime.email}"
}

###################
# Scheduler       #
###################

resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "sentry-ingest-watcher-sch"
  display_name = "Sentry Ingest Watcher Scheduler"
  description  = "OIDC identity used by Cloud Scheduler to invoke the sentry-ingest-watcher function."
}

resource "google_cloudfunctions2_function_iam_member" "scheduler_function_invoker" {
  project        = var.project_id
  location       = var.region
  cloud_function = google_cloudfunctions2_function.sentry_ingest_watcher.name
  role           = "roles/cloudfunctions.invoker"
  member         = "serviceAccount:${google_service_account.scheduler.email}"

  depends_on = [google_cloudfunctions2_function.sentry_ingest_watcher]

  lifecycle {
    replace_triggered_by = [
      google_cloudfunctions2_function.sentry_ingest_watcher
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_cloud_run_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloudfunctions2_function.sentry_ingest_watcher.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"

  depends_on = [google_cloudfunctions2_function.sentry_ingest_watcher]

  lifecycle {
    replace_triggered_by = [
      google_cloudfunctions2_function.sentry_ingest_watcher
    ]
  }
}

resource "google_cloud_scheduler_job" "sentry_ingest_freshness" {
  project     = var.project_id
  name        = var.scheduler_name
  description = "Publish seconds since the Sentry triage ingest last recorded work on its tracker issue"
  region      = var.region
  schedule    = var.schedule
  time_zone   = var.time_zone

  attempt_deadline = "${var.timeout_seconds}s"

  retry_config {
    max_retry_duration   = "300s"
    min_backoff_duration = "5s"
    max_backoff_duration = "60s"
    max_doublings        = 3
  }

  http_target {
    http_method = "POST"
    uri         = google_cloudfunctions2_function.sentry_ingest_watcher.service_config[0].uri

    oidc_token {
      audience              = google_cloudfunctions2_function.sentry_ingest_watcher.service_config[0].uri
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [
    google_cloudfunctions2_function_iam_member.scheduler_function_invoker,
    google_cloud_run_v2_service_iam_member.scheduler_cloud_run_invoker,
  ]
}
