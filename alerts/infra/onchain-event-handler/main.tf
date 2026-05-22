# This module deploys the TypeScript Cloud Function that processes QuickNode webhooks and routes them to Discord


##################
# Cloud Function #
##################

# CKV_GCP_124: ALLOW_ALL ingress - required for QuickNode webhooks from external IPs
# trunk-ignore(checkov/CKV_GCP_124)
resource "google_cloudfunctions2_function" "onchain_event_handler" {
  project     = var.project_id
  name        = var.function_name
  description = "Central dispatcher for Safe multisig alerts across multiple chains: ${join(", ", local.chains)}"
  location    = var.region

  labels = var.common_labels

  build_config {
    runtime     = var.runtime
    entry_point = "processQuicknodeWebhook"
    # Specify the service account for Cloud Build to use
    # Use the full resource name format: projects/PROJECT_ID/serviceAccounts/EMAIL
    service_account = "projects/${var.project_id}/serviceAccounts/${var.project_service_account_email}"
    source {
      storage_source {
        bucket = google_storage_bucket.function_bucket.name
        object = google_storage_bucket_object.function_source.name
      }
    }
  }

  service_config {
    available_memory   = "${var.memory_mb}M"
    timeout_seconds    = var.timeout_seconds
    max_instance_count = var.max_instances
    min_instance_count = var.min_instances
    # Dedicated runtime SA, separate from the Cloud Build SA. The build SA
    # carries `roles/cloudbuild.builds.builder` + GCS source bucket read —
    # if the public HTTP function were compromised with that identity, an
    # attacker could trigger Cloud Builds and modify build configs. The
    # runtime SA only gets `roles/secretmanager.secretAccessor` on the three
    # secrets it needs to read.
    service_account_email          = google_service_account.function_runtime.email
    environment_variables          = local.all_env_vars
    ingress_settings               = "ALLOW_ALL"
    all_traffic_on_latest_revision = true

    # Reference secret from Secret Manager
    secret_environment_variables {
      key        = "QUICKNODE_SIGNING_SECRET"
      project_id = var.project_id
      secret     = google_secret_manager_secret.quicknode_signing_secret.secret_id
      version    = "latest"
    }

    # Discord webhook URLs are credentials too: anyone with `gcloud functions
    # describe` on the project could otherwise read them and post arbitrary
    # messages to the monitored channels. Keep them in Secret Manager next
    # to QUICKNODE_SIGNING_SECRET.
    secret_environment_variables {
      key        = "DISCORD_WEBHOOK_ALERTS"
      project_id = var.project_id
      secret     = google_secret_manager_secret.discord_webhook_alerts.secret_id
      version    = "latest"
    }
    secret_environment_variables {
      key        = "DISCORD_WEBHOOK_EVENTS"
      project_id = var.project_id
      secret     = google_secret_manager_secret.discord_webhook_events.secret_id
      version    = "latest"
    }
  }

  lifecycle {
    precondition {
      condition     = length(var.multisig_webhooks) > 0
      error_message = "At least one multisig webhook configuration must be provided."
    }

    ignore_changes = [
      labels["deployment-tool"],
      labels["goog-terraform-provisioned"],
      # Workaround for Google provider bug with sensitive env vars
      # See: https://github.com/hashicorp/terraform-provider-google/issues/7467
      service_config[0].environment_variables
    ]

    # Force redeploy when secret version changes or source code changes
    replace_triggered_by = [
      google_secret_manager_secret_version.quicknode_signing_secret,
      google_secret_manager_secret_version.discord_webhook_alerts,
      google_secret_manager_secret_version.discord_webhook_events,
      google_storage_bucket_object.function_source
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.quicknode_signing_secret,
    google_secret_manager_secret_version.discord_webhook_alerts,
    google_secret_manager_secret_version.discord_webhook_events,
    # IAM grants for the Cloud Build SA must propagate before the function's
    # build step kicks off, otherwise the build can race ahead and fail
    # even though the IAM resources are in the same plan.
    google_project_iam_member.cloudbuild_builder,
    google_storage_bucket_iam_member.cloud_build_storage_access,
    # Runtime SA needs Secret Manager access before the function boots.
    google_project_iam_member.runtime_secret_accessor,
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
  name     = "${var.project_id}-alert-functions-${random_id.bucket_suffix.hex}"
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

# Random suffix for bucket name uniqueness
resource "random_id" "bucket_suffix" {
  byte_length = 4
}

# Archive function source (Cloud Build will compile TypeScript).
# safe-abi.json lives in this module's dir (committed), so it's included
# automatically. excludes block also drops dev secrets (.env*) and
# terraform-state-derived caches so they never leak into the GCS zip.
data "archive_file" "function_source" {
  type        = "zip"
  source_dir  = path.module
  output_path = "${path.module}/function-source.zip"
  # Terraform's archive provider uses doublestar matching: a single `*` does
  # NOT cross `/`. Use `**/` prefixes to drop test files + state artifacts
  # nested in subdirs (src/**, etc.).
  excludes = [
    "node_modules",
    ".git",
    "**/*.test.ts",
    "**/*.test.js",
    "main.tf",
    "local-dotenv-file.tf",
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
    ".project_vars_cache",
    # Dev-only files: shipping these to the production zip leaks
    # internal gcloud/TF invocations + the canonical webhook fixture.
    "scripts",
    "scripts/**",
    "vitest.config.ts",
    "eslint.config.mjs",
    "knip.json",
    ".prettierrc.json",
    ".prettierignore",
    ".gcloudignore",
    "function-source.zip" # Exclude the zip file itself
  ]
  output_file_mode = "0644"
}

# Upload function source to bucket
# Use our custom source hash instead of the archive's SHA256
# This ensures the function only redeploys when actual source files change
resource "google_storage_bucket_object" "function_source" {
  name   = "onchain-event-handler-${local.source_hash}.zip"
  bucket = google_storage_bucket.function_bucket.name
  source = data.archive_file.function_source.output_path

  lifecycle {
    # Ignore changes to content_type and other metadata that don't affect functionality
    ignore_changes = [
      content_type,
      metadata,
    ]
  }
}

# Allows the Quicknode Webhook service (and everyone else...) to call the cloud function
# Cloud Functions Gen2 requires IAM bindings on both the function and the underlying Cloud Run service
# trunk-ignore(checkov/CKV_GCP_107): Quicknode needs to be able to call the function, plus we're doing signature verification in the function code
resource "google_cloudfunctions2_function_iam_member" "cloud_function_invoker" {
  project        = var.project_id
  location       = var.region
  cloud_function = google_cloudfunctions2_function.onchain_event_handler.name
  role           = "roles/cloudfunctions.invoker"
  # We could probably somehow whitelist the Quicknode Webhook URL or their IP range here instead of allowing everyone to call it,
  # but given the limited damage potential of calling this function it doesn't seem worth the extra effort.
  member = "allUsers"

  # Explicitly depend on the function to ensure IAM binding is applied after function creation
  # This prevents 403 errors when the function is recreated
  depends_on = [google_cloudfunctions2_function.onchain_event_handler]

  # Force IAM binding to be reapplied when the function is recreated
  # This ensures bindings persist across function replacements
  lifecycle {
    replace_triggered_by = [
      google_cloudfunctions2_function.onchain_event_handler
    ]
  }
}

# Also set IAM on the underlying Cloud Run service (required for Cloud Functions Gen2)
resource "google_cloud_run_v2_service_iam_member" "cloud_run_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloudfunctions2_function.onchain_event_handler.name
  role     = "roles/run.invoker"
  member   = "allUsers"

  depends_on = [google_cloudfunctions2_function.onchain_event_handler]

  # Force IAM binding to be reapplied when the function is recreated
  # This ensures bindings persist across function replacements (which recreate the underlying Cloud Run service)
  lifecycle {
    replace_triggered_by = [
      google_cloudfunctions2_function.onchain_event_handler
    ]
  }
}



#####################
# Cloud Build IAM   #
#####################

# Allow Cloud Build service account to access the function source code in the storage bucket
resource "google_storage_bucket_iam_member" "cloud_build_storage_access" {
  bucket = google_storage_bucket.function_bucket.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${var.project_service_account_email}"
}

# Allow Cloud Build service account to build the cloud function and write build logs
resource "google_project_iam_member" "cloudbuild_builder" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.builder"
  # checkov:skip=CKV_GCP_49:The cloudbuild builder role should be safe to assign
  # See https://docs.prismacloud.io/en/enterprise-edition/policy-reference/google-cloud-policies/google-cloud-iam-policies/bc-gcp-iam-10
  member = "serviceAccount:${var.project_service_account_email}"
}


##################
# Secret Manager #
##################

# Create Secret Manager secret for QuickNode signing secret
resource "google_secret_manager_secret" "quicknode_signing_secret" {
  project   = var.project_id
  secret_id = var.secret_name

  replication {
    auto {}
  }

  labels = var.common_labels
}

# Store the secret value
# Include secret data in the version name to force Cloud Function redeploy when secret changes
resource "google_secret_manager_secret_version" "quicknode_signing_secret" {
  secret      = google_secret_manager_secret.quicknode_signing_secret.id
  secret_data = var.quicknode_signing_secret

  # Force Cloud Function to redeploy when secret changes by including secret hash in lifecycle
  lifecycle {
    create_before_destroy = true
  }
}

# Discord webhook URLs (alerts + events channels). Stored as Secret Manager
# secrets rather than plaintext env vars so they aren't visible to anyone
# with `gcloud functions describe` on the project.
resource "google_secret_manager_secret" "discord_webhook_alerts" {
  project   = var.project_id
  secret_id = "${var.secret_name}-discord-alerts"

  replication {
    auto {}
  }

  labels = var.common_labels
}

resource "google_secret_manager_secret_version" "discord_webhook_alerts" {
  secret      = google_secret_manager_secret.discord_webhook_alerts.id
  secret_data = local.shared_webhook_urls.alerts

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_secret_manager_secret" "discord_webhook_events" {
  project   = var.project_id
  secret_id = "${var.secret_name}-discord-events"

  replication {
    auto {}
  }

  labels = var.common_labels
}

resource "google_secret_manager_secret_version" "discord_webhook_events" {
  secret      = google_secret_manager_secret.discord_webhook_events.id
  secret_data = local.shared_webhook_urls.events

  lifecycle {
    create_before_destroy = true
  }
}

# Dedicated runtime SA for the Cloud Function. Separated from the Cloud
# Build SA so a runtime compromise (via the public HTTP endpoint, defended
# in-code by HMAC) can't leverage Cloud Build privileges.
resource "google_service_account" "function_runtime" {
  project      = var.project_id
  account_id   = "onchain-handler-runtime"
  display_name = "Onchain Event Handler Runtime"
  description  = "Runtime identity for the onchain-event-handler Cloud Function. Read-only on Secret Manager; no Cloud Build access."
}

# Grant the runtime SA Secret Manager access (the only privilege it needs).
resource "google_project_iam_member" "runtime_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.function_runtime.email}"
}
