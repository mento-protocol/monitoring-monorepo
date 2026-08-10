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

  sentry_ingest_freshness_metric_type = "custom.googleapis.com/sentry_triage/ingest_freshness_seconds"

  # Ingest runs 2x/day and GitHub's scheduler drifts up to ~3h on this repo, so
  # 26h clears normal drift without hiding an outage.
  sentry_ingest_freshness_threshold_seconds = 26 * 60 * 60

  # Two watcher runs land in every alignment bucket, so a single missed hourly
  # run still leaves a point and cannot read as an absent series.
  sentry_ingest_freshness_alignment_period = "7200s"
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
# handler is at-most-once by design: per-event failures and processing-budget
# skips are logged and intentionally answered with HTTP 200 so QuickNode does
# not replay the batch. These metrics and policies make those drops visible.

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

  notification_channels = [local.alerts_infra_notification_channel]
  severity              = "ERROR"

  alert_strategy {
    auto_close = "86400s"
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

############################################
# Sentry triage ingest dead-man switch     #
############################################

# The freshness gauge published hourly by the sentry-ingest-watcher Cloud
# Function. Declared here rather than left to Cloud Monitoring's implicit
# descriptor creation so the alert policy below binds to a reviewed shape.
resource "google_monitoring_metric_descriptor" "sentry_ingest_freshness" {
  project      = local.project_id
  type         = local.sentry_ingest_freshness_metric_type
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  unit         = "s"
  display_name = "Sentry triage ingest freshness"
  description  = "Seconds since the newest Sentry triage ingest run record on the tracker issue, published by the sentry-ingest-watcher Cloud Function. The record is written only by an ingest that actually fetched and counted issues, so this measures work done, not workflow exit codes."

  depends_on = [module.project_factory]
}

# The dead-man switch itself. Both conditions matter and the second is the
# reason this exists:
#
#   1. The gauge exceeds 26h — no ingest has done any work in that window.
#      The gauge tracks the tracker-issue run record rather than the workflow
#      conclusion, because a kill-switched or token-less run still concludes
#      `success` while ingesting nothing.
#   2. The gauge stops arriving — the watcher itself died, or it refused to
#      publish because GitHub was unreachable or answered with something it
#      could not parse. The function never guesses a value in those cases, so
#      silence is the signal.
#
# `condition_absent` is what makes this a dead-man switch — the Cloud
# Monitoring equivalent of the Grafana `no_data_state = "Alerting"` on "Aegis
# does not report new data" (alerts/rules/rules-aegis-service.tf). A watcher
# that can fail quietly reproduces the incident this switch exists to prevent.
#
# The threshold condition deliberately does NOT set `evaluation_missing_data`.
# Two reasons, in order of weight:
#
#   * It would be redundant. Freshness is an ABSOLUTE age, not a delta, so a
#     gap loses no information: the first point published after any gap carries
#     the true age and trips the 26h threshold on its own if the pipeline is
#     really dead. Treating the gap itself as violating only adds firing while
#     the watcher blips and the pipeline is healthy — a false positive.
#   * The API forbids it here anyway. `MetricThreshold.evaluationMissingData`:
#     "To use this control, the value of the duration field must be greater
#     than or equal to 60 seconds." This condition runs at `duration = "0s"`,
#     so one aligned point over 26h alerts immediately.
#
# So the two conditions divide cleanly: the threshold owns "ingest is stale and
# still reporting", `condition_absent` owns "nothing is reporting at all".
# Neither can fire before the series exists, so confirm the first successful
# publish after apply — see alerts/infra/README.md.
resource "google_monitoring_alert_policy" "sentry_ingest_staleness_policy" {
  project      = local.project_id
  display_name = "sentry-triage-ingest-stale"
  combiner     = "OR"
  enabled      = true
  severity     = "WARNING"

  documentation {
    content   = <<-EOT
      ## Sentry triage ingest has gone quiet

      No Sentry triage ingest has recorded any work in the last 26h, or the
      watcher stopped reporting. Either way the pipeline is not turning new
      Sentry issues into queue issues, and nothing else will say so — the
      pipeline cannot report its own silence.

      A green ingest workflow does not clear this alert. The kill switch and a
      missing token both let a run conclude `success` while ingesting nothing,
      which is why the gauge tracks the run record instead.

      Check, in order:

      1. The run record comment on tracker issue #1282 — its timestamp is what
         this gauge measures:
         https://github.com/mento-protocol/monitoring-monorepo/issues/1282
      2. The kill switch `vars.SENTRY_TRIAGE_ENABLED` and the
         `SENTRY_TRIAGE_TOKEN` secret — both fail safe to a no-op, and a no-op
         run never writes the record.
      3. Recent runs of the ingest workflow:
         https://github.com/mento-protocol/monitoring-monorepo/actions/workflows/sentry-triage-ingest.yml
      4. The watcher itself, when the gauge is absent rather than high:
         https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%20AND%20resource.labels.service_name%3D%22${module.sentry_ingest_watcher.function_name}%22%20AND%20severity%3E%3DERROR;duration=PT24H
      5. Scheduler attempts:
         https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_scheduler_job%22%20AND%20resource.labels.job_id%3D%22${module.sentry_ingest_watcher.scheduler_job_name}%22;duration=PT24H

      Runbook: `docs/notes/sentry-triage-pipeline.md`.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "No recorded ingest work in 26h"

    condition_threshold {
      filter = <<EOF
        resource.type = "global" AND
        metric.type   = "${local.sentry_ingest_freshness_metric_type}"
      EOF

      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = local.sentry_ingest_freshness_threshold_seconds

      aggregations {
        alignment_period   = local.sentry_ingest_freshness_alignment_period
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "Watcher stopped publishing ingest freshness"

    condition_absent {
      filter = <<EOF
        resource.type = "global" AND
        metric.type   = "${local.sentry_ingest_freshness_metric_type}"
      EOF

      # Reads as 3h; the real latency is 5h. The aggregation below means an
      # aligned point persists while its trailing 7200s window still contains
      # the last raw publish, so this timer only starts 2h after the watcher
      # goes quiet. Measured 2026-08-10: last publish 12:00:02Z, alert
      # 17:02:12Z. Do not "fix" a slow-looking absence alert by shortening
      # this — see alerts/infra/README.md § "After apply: prove the switch
      # fires" step 3, and drop the aggregations block instead if 3h is
      # actually required.
      duration = "10800s"

      aggregations {
        alignment_period   = local.sentry_ingest_freshness_alignment_period
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [local.alerts_infra_notification_channel]

  alert_strategy {
    auto_close = "86400s"
  }

  depends_on = [
    module.project_factory,
    google_monitoring_metric_descriptor.sentry_ingest_freshness,
  ]
}
