# =============================================================================
# Cloud Scheduler - QuickNode Webhook Health Check
# =============================================================================
# Periodically triggers the /quicknode-health endpoint to check if all
# QuickNode webhooks are active. If any webhook is terminated or paused,
# it will log an error which triggers a Slack alert via error_logs_policy.

# Service account for Cloud Scheduler to invoke the Cloud Function
resource "google_service_account" "scheduler_invoker" {
  project      = module.governance_watchdog.project_id
  account_id   = "scheduler-invoker"
  display_name = "Cloud Scheduler Invoker"
  description  = "Service account used by Cloud Scheduler to invoke Cloud Functions"
}

# Grant the scheduler service account permission to invoke the Cloud Function
resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  project  = module.governance_watchdog.project_id
  location = google_cloudfunctions2_function.watchdog_notifications.location
  name     = google_cloudfunctions2_function.watchdog_notifications.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Cloud Scheduler job that checks QuickNode webhook health every hour
resource "google_cloud_scheduler_job" "quicknode_health_check" {
  project     = module.governance_watchdog.project_id
  region      = var.region
  name        = "quicknode-webhook-health-check"
  description = "Checks QuickNode webhook status every hour and alerts if any webhook is not active"
  schedule    = "0 * * * *" # Every hour at minute 0
  time_zone   = "UTC"

  # Note: If the health check fails, retries may generate multiple error logs which could
  # trigger multiple Slack alerts. However, the error_logs_policy has a 60s aggregation
  # window which should deduplicate alerts within that period.
  retry_config {
    retry_count          = 1 # Reduced from 3 to avoid alert spam if QuickNode API is down
    min_backoff_duration = "30s"
    max_backoff_duration = "60s"
  }

  http_target {
    uri         = "${google_cloudfunctions2_function.watchdog_notifications.service_config[0].uri}/quicknode-health"
    http_method = "GET"

    oidc_token {
      service_account_email = google_service_account.scheduler_invoker.email
      audience              = google_cloudfunctions2_function.watchdog_notifications.service_config[0].uri
    }
  }
}
