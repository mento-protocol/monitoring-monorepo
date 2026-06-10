# Creates a metric that counts the number of log entries containing 'HealthCheck' in the watchdog cloud function.
resource "google_logging_metric" "health_check_metric" {
  project     = module.governance_watchdog.project_id
  name        = "health_check_logs_count"
  description = "Number of log entries containing 'health check' in the watchdog cloud function"
  filter      = <<EOF
    severity=DEFAULT
    SEARCH("`[HealthCheck]`")
    resource.labels.service_name="${google_cloudfunctions2_function.watchdog_notifications.name}"
  EOF
}

# Creates a notification channel where alerts will be sent based on the alert policy below.
resource "google_monitoring_notification_channel" "victorops_channel" {
  project      = module.governance_watchdog.project_id
  display_name = "Splunk (VictorOps)"
  type         = "webhook_tokenauth"

  labels = {
    url = var.victorops_webhook_url
  }
}

# Creates an alert policy that triggers when no health check logs have been received in the last 6 hours,
# and sends a notification to the channel above.
resource "google_monitoring_alert_policy" "health_check_policy" {
  project      = module.governance_watchdog.project_id
  display_name = "no-health-check-logs"
  combiner     = "OR"
  enabled      = true

  documentation {
    content = "No health check events have been logged in the last 6 hours"
  }

  conditions {
    display_name = "No health check logs in 6 hours"

    condition_threshold {
      filter = <<EOF
        resource.type = "cloud_run_revision" AND
        metric.type   = "logging.googleapis.com/user/${google_logging_metric.health_check_metric.name}"
      EOF

      duration        = "300s" # Re-test the condition every 5 minutes
      comparison      = "COMPARISON_LT"
      threshold_value = 1

      aggregations {
        alignment_period     = "21600s" # 6 hours
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.victorops_channel.id]
  severity              = "CRITICAL"

  # This is a workaround to prevent the alert from being automatically closed after 7 days (even if still firing)
  alert_strategy {
    auto_close = "1800000s" # 20+ years, effectively never auto-close
  }
}

# =============================================================================
# Error Alerting (Slack)
# =============================================================================

# Creates a metric that counts ERROR-level logs in the watchdog cloud function.
resource "google_logging_metric" "error_logs_metric" {
  project     = module.governance_watchdog.project_id
  name        = "error_logs_count"
  description = "Number of ERROR-level log entries in the watchdog cloud function"
  filter      = <<EOF
    severity>=ERROR
    resource.type="cloud_run_revision"
    resource.labels.service_name="${google_cloudfunctions2_function.watchdog_notifications.name}"
  EOF
}

# Creates an alert policy that triggers when errors occur in the cloud function.
# Note: The Slack notification channel is created manually via OAuth in GCP Console
# and referenced here by ID (not managed by Terraform).
# This resource is only created if a Slack notification channel ID is provided.
resource "google_monitoring_alert_policy" "error_logs_policy" {
  count = var.slack_notification_channel_id != "" ? 1 : 0

  project      = module.governance_watchdog.project_id
  display_name = "cloud-function-errors"
  combiner     = "OR"
  enabled      = true

  documentation {
    content   = <<-EOT
      ## Error detected in Governance Watchdog Cloud Function

      **View recent error logs:**
      https://console.cloud.google.com/logs/query;query=severity%3E%3DERROR%20AND%20resource.labels.service_name%3D%22${google_cloudfunctions2_function.watchdog_notifications.name}%22;duration=PT3H

      _(Link shows last 3 hours of error logs)_
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    # Intentional: requires 2+ errors in a 5-minute window before alerting.
    # Single transient QuickNode API timeouts (522s) were causing false pages.
    # A genuine outage will produce sustained errors and still trigger quickly.
    display_name = "2+ errors in 5 minutes (burst detection)"

    condition_threshold {
      filter = <<EOF
        resource.type = "cloud_run_revision" AND
        metric.type   = "logging.googleapis.com/user/${google_logging_metric.error_logs_metric.name}"
      EOF

      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1 # >1 means 2+ errors required

      aggregations {
        alignment_period     = "300s" # 5-minute window
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  # References Slack channel created via OAuth in GCP Console (not managed by Terraform)
  notification_channels = ["projects/${module.governance_watchdog.project_id}/notificationChannels/${var.slack_notification_channel_id}"]
  severity              = "ERROR"

  alert_strategy {
    auto_close = "86400s" # Auto-close after 24 hours if no new errors
  }
}

# =============================================================================
# QuickNode Webhook Health Alerting (Slack)
# =============================================================================
# Alerts when QuickNode signature verification fails repeatedly, which is an
# early warning that a webhook may get terminated by QuickNode.

# Creates a metric that counts signature verification failures.
resource "google_logging_metric" "signature_failure_metric" {
  project     = module.governance_watchdog.project_id
  name        = "quicknode_signature_failures"
  description = "Number of QuickNode signature verification failures"
  filter      = <<EOF
    resource.type="cloud_run_revision"
    resource.labels.service_name="${google_cloudfunctions2_function.watchdog_notifications.name}"
    textPayload:"QuickNode signature verification failed"
  EOF
}

# Creates an alert policy that triggers when signature failures occur.
# This is an early warning that a QuickNode webhook may be misconfigured
# and could be terminated if the failures continue.
# This resource is only created if a Slack notification channel ID is provided.
resource "google_monitoring_alert_policy" "signature_failure_policy" {
  count = var.slack_notification_channel_id != "" ? 1 : 0

  project      = module.governance_watchdog.project_id
  display_name = "quicknode-signature-failures"
  combiner     = "OR"
  enabled      = true

  documentation {
    content   = <<-EOT
      ## QuickNode Signature Verification Failures Detected

      QuickNode webhook requests have failed signature verification.
      This can mean the security token configured in QuickNode doesn't
      match what's stored in GCP Secret Manager. Or the cloud function code
      processing this webhook is not working correctly.

      **If not fixed, QuickNode will likely TERMINATE the webhook after repeated failures**

      ### To Fix:
      1. Go to [QuickNode Dashboard](https://dashboard.quicknode.com/webhooks)
      2. Check the security token for the failing webhook
      3. Ensure it matches the value in GCP Secret Manager:
         ```
         gcloud secrets versions access latest --secret="quicknode_security_token" --project="${module.governance_watchdog.project_id}"
         ```
      4. Update the webhook in QuickNode with the correct token
      5. If the token is correct, check the logs for the cloud function to see if there are any errors processing the webhook.

      ### To Check Logs:
      ```
      gcloud logging read 'textPayload:"signature verification failed" AND resource.labels.service_name="${google_cloudfunctions2_function.watchdog_notifications.name}"' --limit=20 --format='table(timestamp,textPayload)'
      ```
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "Signature verification failures detected"

    condition_threshold {
      filter = <<EOF
        resource.type = "cloud_run_revision" AND
        metric.type   = "logging.googleapis.com/user/${google_logging_metric.signature_failure_metric.name}"
      EOF

      duration        = "0s" # Alert immediately
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period     = "300s" # Check every 5 minutes
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  # References Slack channel created via OAuth in GCP Console (not managed by Terraform)
  notification_channels = ["projects/${module.governance_watchdog.project_id}/notificationChannels/${var.slack_notification_channel_id}"]
  severity              = "WARNING"

  alert_strategy {
    auto_close = "3600s" # Auto-close after 1 hour if no new failures
  }
}
