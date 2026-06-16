# Drop-path observability for the onchain-event-handler Cloud Function.
# The handler is at-most-once by design: per-event failures and processing
# budget skips are logged and intentionally answered with HTTP 200 so QuickNode
# does not replay the batch. These metrics and policies make those drops
# human-visible. Pattern mirrors governance-watchdog/infra/monitoring.tf.

# Counts drop-path ERROR-level logs from the handler. Pinned to the handler's
# service name so oncall-announcer errors in the same project do not cross-page;
# narrowed to per-event drop logs so public auth probes do not page.
resource "google_logging_metric" "onchain_handler_errors" {
  project     = local.project_id
  name        = "onchain_event_handler_error_logs"
  description = "Drop-path ERROR-level log entries in the onchain-event-handler Cloud Function (dropped Safe alerts)"
  filter      = <<EOF
    severity>=ERROR
    resource.type="cloud_run_revision"
    resource.labels.service_name="${module.onchain_event_handler.function_name}"
    (
      jsonPayload.message.message="Error processing log" OR
      jsonPayload.message="Error processing log" OR
      jsonPayload.message.message="No notification channel found" OR
      jsonPayload.message="No notification channel found"
    )
  EOF
}

# Counts events skipped because the processing budget elapsed. These are logged
# at WARNING with a stable reason field, so the ERROR metric above does not see
# them. Match both direct structured-logger fields and LogSync's nested message
# payload shape.
resource "google_logging_metric" "onchain_handler_budget_skips" {
  project     = local.project_id
  name        = "onchain_event_handler_budget_skips"
  description = "Log entries reporting events skipped by the onchain-event-handler processing budget"
  filter      = <<EOF
    severity="WARNING"
    resource.type="cloud_run_revision"
    resource.labels.service_name="${module.onchain_event_handler.function_name}"
    (
      jsonPayload.message.reason="skipped_due_to_timeout" OR
      jsonPayload.reason="skipped_due_to_timeout"
    )
  EOF
}

resource "google_monitoring_alert_policy" "onchain_handler_errors_policy" {
  count = var.slack_notification_channel_id != "" ? 1 : 0

  project      = local.project_id
  display_name = "onchain-event-handler-errors"
  combiner     = "OR"
  enabled      = true

  documentation {
    content   = <<-EOT
      ## Error in onchain-event-handler (likely a dropped Safe multisig alert)

      The handler logs ERROR and answers HTTP 200 on per-event failures, so
      QuickNode will NOT redeliver. Check the logs and re-verify the affected
      Safe transactions manually.

      **View recent error logs:**
      https://console.cloud.google.com/logs/query;query=severity%3E%3DERROR%20AND%20resource.labels.service_name%3D%22${module.onchain_event_handler.function_name}%22%20AND%20(jsonPayload.message.message%3D%22Error%20processing%20log%22%20OR%20jsonPayload.message%3D%22Error%20processing%20log%22%20OR%20jsonPayload.message.message%3D%22No%20notification%20channel%20found%22%20OR%20jsonPayload.message%3D%22No%20notification%20channel%20found%22);duration=PT24H
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "Any handler error in 5 minutes"

    condition_threshold {
      filter = <<EOF
        resource.type = "cloud_run_revision" AND
        metric.type   = "logging.googleapis.com/user/${google_logging_metric.onchain_handler_errors.name}"
      EOF

      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = ["projects/${local.project_id}/notificationChannels/${var.slack_notification_channel_id}"]
  severity              = "ERROR"

  alert_strategy {
    auto_close = "86400s"
  }
}

resource "google_monitoring_alert_policy" "onchain_handler_budget_skips_policy" {
  count = var.slack_notification_channel_id != "" ? 1 : 0

  project      = local.project_id
  display_name = "onchain-event-handler-budget-skips"
  combiner     = "OR"
  enabled      = true

  documentation {
    content   = <<-EOT
      ## Processing-budget skip in onchain-event-handler

      The onchain-event-handler ran out of processing budget and skipped Safe
      events without alerting on them. QuickNode will not redeliver — re-verify
      recent Safe multisig activity manually.

      **View recent budget-skip logs:**
      https://console.cloud.google.com/logs/query;query=(jsonPayload.message.reason%3D%22skipped_due_to_timeout%22%20OR%20jsonPayload.reason%3D%22skipped_due_to_timeout%22)%20AND%20resource.labels.service_name%3D%22${module.onchain_event_handler.function_name}%22;duration=PT24H
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "Any budget skip in 5 minutes"

    condition_threshold {
      filter = <<EOF
        resource.type = "cloud_run_revision" AND
        metric.type   = "logging.googleapis.com/user/${google_logging_metric.onchain_handler_budget_skips.name}"
      EOF

      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = ["projects/${local.project_id}/notificationChannels/${var.slack_notification_channel_id}"]
  severity              = "ERROR"

  alert_strategy {
    auto_close = "86400s"
  }
}
