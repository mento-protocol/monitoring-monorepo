##################
# Cloud Function #
##################

# CKV_GCP_124: ALLOW_ALL ingress is required for Cloud Scheduler HTTP targets;
# invocation is still restricted to the scheduler service account via OIDC IAM.
# trunk-ignore(checkov/CKV_GCP_124)
resource "google_cloudfunctions2_function" "oncall_announcer" {
  project     = var.project_id
  name        = var.function_name
  description = "Announces Splunk On-Call rotations to Slack and reconciles @support-engineer"
  location    = var.region

  labels = var.common_labels

  build_config {
    runtime         = var.runtime
    entry_point     = "handleOncallRotation"
    service_account = "projects/${var.project_id}/serviceAccounts/${var.project_service_account_email}"
    source {
      storage_source {
        bucket = google_storage_bucket.function_bucket.name
        object = google_storage_bucket_object.function_source.name
      }
    }
  }

  service_config {
    available_memory               = "${var.memory_mb}M"
    timeout_seconds                = var.timeout_seconds
    max_instance_count             = var.max_instances
    min_instance_count             = var.min_instances
    service_account_email          = google_service_account.function_runtime.email
    environment_variables          = local.all_env_vars
    ingress_settings               = "ALLOW_ALL"
    all_traffic_on_latest_revision = true

    secret_environment_variables {
      key        = "SLACK_BOT_TOKEN"
      project_id = var.project_id
      secret     = google_secret_manager_secret.slack_bot_token.secret_id
      version    = "latest"
    }

    secret_environment_variables {
      key        = "SPLUNK_ON_CALL_API_ID"
      project_id = var.project_id
      secret     = google_secret_manager_secret.splunk_on_call_api_id.secret_id
      version    = "latest"
    }

    secret_environment_variables {
      key        = "SPLUNK_ON_CALL_API_KEY"
      project_id = var.project_id
      secret     = google_secret_manager_secret.splunk_on_call_api_key.secret_id
      version    = "latest"
    }
  }

  lifecycle {
    ignore_changes = [
      labels["deployment-tool"],
      labels["goog-terraform-provisioned"],
      service_config[0].environment_variables
    ]

    replace_triggered_by = [
      google_secret_manager_secret_version.slack_bot_token,
      google_secret_manager_secret_version.splunk_on_call_api_id,
      google_secret_manager_secret_version.splunk_on_call_api_key,
      google_storage_bucket_object.function_source
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runtime_slack_bot_token,
    google_secret_manager_secret_iam_member.runtime_splunk_on_call_api_id,
    google_secret_manager_secret_iam_member.runtime_splunk_on_call_api_key,
    google_storage_bucket_iam_member.cloud_build_storage_access,
    google_storage_bucket_iam_member.runtime_rotation_state_object_admin,
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

# trunk-ignore(checkov/CKV_GCP_62)
resource "google_storage_bucket" "function_bucket" {
  project  = var.project_id
  name     = "${var.project_id}-oncall-announcer-source-${random_id.bucket_suffix.hex}"
  location = var.region

  uniform_bucket_level_access = true
  force_destroy               = true
  public_access_prevention    = "enforced"

  labels = var.common_labels

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = false
    ignore_changes  = [labels["goog-terraform-provisioned"]]
  }
}

# trunk-ignore(checkov/CKV_GCP_62): bucket stores only the last announced on-call user id
resource "google_storage_bucket" "rotation_state" {
  project  = var.project_id
  name     = "${var.project_id}-oncall-announcer-state-${random_id.bucket_suffix.hex}"
  location = var.region

  uniform_bucket_level_access = true
  force_destroy               = true
  public_access_prevention    = "enforced"

  labels = var.common_labels

  versioning {
    enabled = true
  }

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
    "dist",
    "dist/**",
    ".git",
    "**/*.test.ts",
    "**/*.test.js",
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
    "vitest.config.ts",
    "eslint.config.mjs",
    "knip.json",
    ".prettierrc.json",
    ".prettierignore",
    ".gcloudignore",
    "function-source.zip"
  ]
  output_file_mode = "0644"
}

resource "google_storage_bucket_object" "function_source" {
  name           = "oncall-announcer-${local.source_hash}.zip"
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

##################
# Secret Manager #
##################

resource "google_secret_manager_secret" "slack_bot_token" {
  project   = var.project_id
  secret_id = "oncall-announcer-slack-bot-token"

  replication {
    auto {}
  }

  labels = var.common_labels
}

resource "google_secret_manager_secret_version" "slack_bot_token" {
  secret      = google_secret_manager_secret.slack_bot_token.id
  secret_data = var.slack_bot_token

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_secret_manager_secret" "splunk_on_call_api_id" {
  project   = var.project_id
  secret_id = "oncall-announcer-splunk-on-call-api-id"

  replication {
    auto {}
  }

  labels = var.common_labels
}

resource "google_secret_manager_secret_version" "splunk_on_call_api_id" {
  secret      = google_secret_manager_secret.splunk_on_call_api_id.id
  secret_data = var.splunk_on_call_api_id

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_secret_manager_secret" "splunk_on_call_api_key" {
  project   = var.project_id
  secret_id = "oncall-announcer-splunk-on-call-api-key"

  replication {
    auto {}
  }

  labels = var.common_labels
}

resource "google_secret_manager_secret_version" "splunk_on_call_api_key" {
  secret      = google_secret_manager_secret.splunk_on_call_api_key.id
  secret_data = var.splunk_on_call_api_key

  lifecycle {
    create_before_destroy = true
  }
}

###################
# Runtime IAM     #
###################

resource "google_service_account" "function_runtime" {
  project      = var.project_id
  account_id   = "oncall-announcer-rt"
  display_name = "On-call Announcer Runtime"
  description  = "Runtime identity for the oncall-announcer Cloud Function. Read-only on secrets; object admin only on its state bucket."
}

resource "google_secret_manager_secret_iam_member" "runtime_slack_bot_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.slack_bot_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.function_runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_splunk_on_call_api_id" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.splunk_on_call_api_id.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.function_runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_splunk_on_call_api_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.splunk_on_call_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.function_runtime.email}"
}

resource "google_storage_bucket_iam_member" "runtime_rotation_state_object_admin" {
  bucket = google_storage_bucket.rotation_state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.function_runtime.email}"
}

###################
# Scheduler       #
###################

resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "oncall-announcer-sched"
  display_name = "On-call Announcer Scheduler"
  description  = "OIDC identity used by Cloud Scheduler to invoke the oncall-announcer function."
}

resource "google_cloudfunctions2_function_iam_member" "scheduler_function_invoker" {
  project        = var.project_id
  location       = var.region
  cloud_function = google_cloudfunctions2_function.oncall_announcer.name
  role           = "roles/cloudfunctions.invoker"
  member         = "serviceAccount:${google_service_account.scheduler.email}"

  depends_on = [google_cloudfunctions2_function.oncall_announcer]

  lifecycle {
    replace_triggered_by = [
      google_cloudfunctions2_function.oncall_announcer
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_cloud_run_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloudfunctions2_function.oncall_announcer.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"

  depends_on = [google_cloudfunctions2_function.oncall_announcer]

  lifecycle {
    replace_triggered_by = [
      google_cloudfunctions2_function.oncall_announcer
    ]
  }
}

resource "google_cloud_scheduler_job" "oncall_rotation" {
  project     = var.project_id
  name        = var.scheduler_name
  description = "Poll Splunk On-Call and announce support-engineer rotations to Slack"
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
    uri         = google_cloudfunctions2_function.oncall_announcer.service_config[0].uri

    oidc_token {
      audience              = google_cloudfunctions2_function.oncall_announcer.service_config[0].uri
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [
    google_cloudfunctions2_function_iam_member.scheduler_function_invoker,
    google_cloud_run_v2_service_iam_member.scheduler_cloud_run_invoker,
  ]
}
