# Operational alerts for the alerts-infra Cloud Functions and schedulers.
# Terraform creates the default GCP Monitoring Slack channel for #alerts-infra
# with the existing bot token. Operators can instead supply an existing GCP
# notification-channel ID during a migration or recovery.

locals {
  alerts_infra_slack_channel_name = "#alerts-infra"
  alerts_infra_notification_channel = (
    var.slack_notification_channel_id != ""
    ? "projects/${local.project_id}/notificationChannels/${var.slack_notification_channel_id}"
    : google_monitoring_notification_channel.alerts_infra_slack[0].name
  )
}

resource "google_monitoring_notification_channel" "alerts_infra_slack" {
  count = var.slack_notification_channel_id == "" ? 1 : 0

  project      = local.project_id
  display_name = "Slack ${local.alerts_infra_slack_channel_name}"
  description  = "Alerts from the alerts-infra GCP project"
  type         = "slack"
  enabled      = true
  force_delete = false

  labels = {
    channel_name = local.alerts_infra_slack_channel_name
    # GCP populates the Slack workspace label after channel creation. Model
    # that stable provider value so refresh-only plans do not remove it.
    team = "Mento Labs"
  }

  sensitive_labels {
    # Keep the bot token out of Terraform state. The hash changes whenever the
    # token rotates and tells the provider to resend the write-only value.
    auth_token_wo         = var.slack_bot_token
    auth_token_wo_version = sha256(var.slack_bot_token)
  }

  depends_on = [module.project_factory]
}

# Drop-path observability for the onchain-event-handler Cloud Function. The
# Safe event handling is at-most-once: per-event failures and budget skips log
# and answer HTTP 200. Pool staging failures answer 503 for QuickNode retries;
# a request-log 5xx signal pages even if staging never produced a GCS record.

# Counts drop-path ERROR logs and public 5xx requests from the handler and its
# private Watched LP retry worker. The 5xx branch catches failures before a
# withdrawal can be staged, even when application logging itself fails.
resource "google_logging_metric" "onchain_handler_errors" {
  project     = local.project_id
  name        = "onchain_event_handler_error_logs"
  description = "Safe drop and watched LP delivery/retry ERROR logs plus public webhook 5xx requests"
  filter      = <<EOF
    resource.type="cloud_run_revision"
    (resource.labels.service_name="${module.onchain_event_handler.function_name}" OR
     resource.labels.service_name="onchain-pool-liquidity-retry")
    (
      (severity>=ERROR AND (
        jsonPayload.message.message="Error processing log" OR
        jsonPayload.message="Error processing log" OR
        jsonPayload.message.message="No notification channel found" OR
        jsonPayload.message="No notification channel found" OR
        jsonPayload.message.message="Watched LP withdrawal delivery failed" OR
        jsonPayload.message="Watched LP withdrawal delivery failed" OR
        jsonPayload.message.message="Watched LP withdrawal retry failed" OR
        jsonPayload.message="Watched LP withdrawal retry failed"
      )) OR
      (resource.labels.service_name="${module.onchain_event_handler.function_name}" AND
       httpRequest.status>=500 AND httpRequest.status<600)
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

# These policies were previously conditional on an operator-supplied channel
# ID. Preserve their state addresses when migrating an existing stack to the
# Terraform-managed #alerts-infra channel.
moved {
  from = google_monitoring_alert_policy.onchain_handler_errors_policy[0]
  to   = google_monitoring_alert_policy.onchain_handler_errors_policy
}

moved {
  from = google_monitoring_alert_policy.onchain_handler_budget_skips_policy[0]
  to   = google_monitoring_alert_policy.onchain_handler_budget_skips_policy
}

resource "google_monitoring_alert_policy" "onchain_handler_errors_policy" {
  project      = local.project_id
  display_name = "onchain-event-handler-errors"
  combiner     = "OR"
  enabled      = true

  documentation {
    content   = <<-EOT
      ## On-chain alert delivery error

      Safe per-event failures log ERROR but answer HTTP 200, so QuickNode will
      not redeliver. Check the logs and re-verify affected Safe transactions.

      Pool staging failures answer HTTP 503 and require operator backfill if
      QuickNode's signed retries expire. Check the public function's 5xx request
      log and Polygon logs for unstaged Burns. Staged records remain in GCS for
      the private retry worker; check `pool-liquidity-withdrawals/137/` too.

      **View recent function and request logs:**
      https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22;duration=PT24H
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

  notification_channels = [local.alerts_infra_notification_channel]
  severity              = "ERROR"

  alert_strategy {
    auto_close = "86400s"
  }

  depends_on = [module.project_factory]
}

# The Watched LP retry function cannot log if Scheduler fails to invoke it. Match
# terminal Scheduler attempts directly so OIDC/IAM, timeout, unreachable-target,
# and handler 5xx failures all reach #alerts-infra independently of app logs.
resource "google_monitoring_alert_policy" "pool_liquidity_retry_scheduler_errors_policy" {
  project      = local.project_id
  display_name = "onchain-pool-liquidity-retry-scheduler-errors"
  combiner     = "OR"
  enabled      = true
  severity     = "ERROR"

  documentation {
    content   = <<-EOT
      ## pool LP-withdrawal retry scheduler failure

      The private Watched LP retry job failed. Staged Polygon EURm/USDm withdrawal
      records may remain pending even if the retry function has no error log.
      Check the newest Scheduler attempt for OIDC/IAM, timeout, target, or
      function errors, then inspect `pool-liquidity-withdrawals/137/` GCS records.

      **View Scheduler errors:**
      https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_scheduler_job%22%20AND%20resource.labels.job_id%3D%22${module.onchain_event_handler.pool_liquidity_retry_scheduler_job_name}%22%20AND%20severity%3E%3DERROR;duration=PT24H
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "Any failed Watched LP retry attempt"

    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_scheduler_job"
        resource.labels.job_id="${module.onchain_event_handler.pool_liquidity_retry_scheduler_job_name}"
        resource.labels.location="${var.region}"
        log_id("cloudscheduler.googleapis.com/executions")
        severity>=ERROR
        jsonPayload."@type"="type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished"
      EOT
    }
  }

  notification_channels = [local.alerts_infra_notification_channel]

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "1800s"
  }

  depends_on = [module.project_factory]
}

resource "google_monitoring_alert_policy" "onchain_handler_budget_skips_policy" {
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

  notification_channels = [local.alerts_infra_notification_channel]
  severity              = "ERROR"

  alert_strategy {
    auto_close = "86400s"
  }

  depends_on = [module.project_factory]
}

# Alert from the scheduler's terminal attempt log instead of the function's
# application log. This catches handler 5xx responses as well as invocation,
# IAM, timeout, and unreachable-target failures before they can leave
# @support-engineer stale. Scheduler retries match the same condition, so the
# notification rate limit collapses the retry burst and caps prolonged-outage
# reminders at one Slack message per hour.
resource "google_monitoring_alert_policy" "oncall_announcer_scheduler_errors_policy" {
  count = local.oncall_announcer_enabled ? 1 : 0

  project      = local.project_id
  display_name = "oncall-announcer-scheduler-errors"
  combiner     = "OR"
  enabled      = true
  severity     = "ERROR"

  documentation {
    content   = <<-EOT
      ## On-call announcer scheduler failure

      The Splunk On-Call to Slack reconciliation job failed. The
      `@support-engineer` usergroup may still point at the previous engineer.

      Check the newest scheduler error, then follow its Cloud Function request
      to the underlying Splunk, Slack, state, or IAM failure. For identity
      lookup errors, compare the Splunk On-Call email with the user's primary
      Slack email.

      **View scheduler errors:**
      https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_scheduler_job%22%20AND%20resource.labels.job_id%3D%22${module.oncall_announcer[0].scheduler_job_name}%22%20AND%20severity%3E%3DERROR;duration=PT24H

      **View function errors:**
      https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%20AND%20resource.labels.service_name%3D%22${module.oncall_announcer[0].function_name}%22%20AND%20severity%3E%3DERROR;duration=PT24H
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "Any failed on-call reconciliation attempt"

    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_scheduler_job"
        resource.labels.job_id="${module.oncall_announcer[0].scheduler_job_name}"
        resource.labels.location="${var.region}"
        log_id("cloudscheduler.googleapis.com/executions")
        severity>=ERROR
        jsonPayload."@type"="type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished"
      EOT
    }
  }

  notification_channels = [local.alerts_infra_notification_channel]

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "1800s"
  }

  depends_on = [module.project_factory]
}
