resource "google_cloudfunctions2_function" "watchdog_notifications" {
  project     = module.governance_watchdog.project_id
  location    = var.region
  name        = var.function_name
  description = "A cloud function that receives blockchain event data from Quicknode Webhook and sends notifications to a Discord channel"

  build_config {
    runtime         = "nodejs22"
    entry_point     = var.function_entry_point
    service_account = module.governance_watchdog.service_account_name

    source {
      storage_source {
        bucket = google_storage_bucket.watchdog_notifications_function.name
        object = google_storage_bucket_object.source_code.name
      }
    }
  }

  service_config {
    available_memory      = "512M"
    service_account_email = module.governance_watchdog.service_account_email
    timeout_seconds       = 60

    # 🔒 Security Note: Checkov recommends to only allow this function to be called from a cloud load balancer.
    # We're making a conscious security tradeoff here for lower complexity and faster delivery. It seems unlikely
    # that this function will get DDoS'ed and even if, the damage would be limited to temporary spam in a Discord channel.
    # checkov:skip=CKV_GCP_124: "Conscious security tradeoff to lower complexity and accelerate delivery."
    ingress_settings = "ALLOW_ALL"

    environment_variables = {
      # Necessary for the function to be able to find the secrets in Secret Manager
      GCP_PROJECT_ID                     = module.governance_watchdog.project_id
      DISCORD_WEBHOOK_URL_SECRET_ID      = google_secret_manager_secret.discord_webhook_url.secret_id
      TELEGRAM_BOT_TOKEN_SECRET_ID       = google_secret_manager_secret.telegram_bot_token.secret_id
      TELEGRAM_CHAT_ID                   = var.telegram_chat_id
      QUICKNODE_SECURITY_TOKEN_SECRET_ID = google_secret_manager_secret.quicknode_security_token.secret_id
      QUICKNODE_API_KEY_SECRET_ID        = google_secret_manager_secret.quicknode_api_key.secret_id
      X_AUTH_TOKEN_SECRET_ID             = google_secret_manager_secret.x_auth_token.secret_id

      # Logs execution ID for easier debugging => https://cloud.google.com/functions/docs/monitoring/logging#viewing_runtime_logs
      LOG_EXECUTION_ID = true
    }
  }
}

# Allows the Quicknode Webhook service (and everyone else...) to call the cloud function
resource "google_cloud_run_v2_service_iam_member" "cloud_function_invoker" {
  project  = module.governance_watchdog.project_id
  location = google_cloudfunctions2_function.watchdog_notifications.location
  name     = google_cloudfunctions2_function.watchdog_notifications.name
  role     = "roles/run.invoker"
  # We could probably somehow whitelist the Quicknode Webhook URL or their IP range here instead of allowing everyone to call it,
  # but given the limited damage potential of calling this function it doesn't seem worth the extra effort.
  # checkov:skip=CKV_GCP_102: "Function needs to be publicly accessible for Quicknode Webhook to be able to invoke it."
  member = "allUsers"
}

# Allows the cloud function to access secrets (i.e. the Discord webhook URL) stored in Secret Manager
resource "google_project_iam_member" "secret_accessor" {
  project = module.governance_watchdog.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${module.governance_watchdog.service_account_email}"
}

output "function_uri" {
  value = google_cloudfunctions2_function.watchdog_notifications.service_config[0].uri
}
