###############
# Alert Rules #
###############
#
# Two `sentry_alert` resources per Sentry project:
#
#   1. `slack_default` — fires on issue lifecycle (first_seen / regression /
#      reappeared) across all environments. Posts to the per-project Slack
#      channel `#sentry-<project-slug>`.
#
#   2. `slack_critical_fanout` — same lifecycle triggers but scoped to
#      `environment = "production"`, filtered to `level == fatal`. Posts
#      additionally to `#alerts-critical` so on-call sees the page-grade
#      events alongside Grafana criticals.
#
# Both resources read their monitor IDs from the default issue-stream
# monitor that Sentry creates per-project. The shape replaces the deprecated
# `sentry_issue_alert` (per-event) model with the new monitor-driven
# `sentry_alert` (per-lifecycle-event) model — see
# https://docs.sentry.io/product/new-monitors-and-alerts/

# Default alert per project — every issue lifecycle event lands in the
# project's own Slack channel.
resource "sentry_alert" "slack_default" {
  for_each = local.projects

  organization      = data.sentry_organization.main.internal_id
  name              = "${each.key} - Forward to Slack"
  monitor_ids       = [data.sentry_project_issue_stream_monitor.default[each.key].id]
  frequency_minutes = 5

  trigger_conditions = [
    { first_seen_event = {} },
    { regression_event = {} },
    { reappeared_event = {} },
  ]

  action_filters = [
    {
      logic_type = "all"
      actions = [
        {
          slack = {
            integration_id = data.sentry_organization_integration.slack.id
            channel_name   = "#sentry-${each.key}"
            # channel_id is documented as a rate-limit-safe optional field.
            # Wired through restapi_object so Sentry resolves the channel
            # without hitting Slack's `conversations.list` on each notify.
            channel_id = restapi_object.sentry_slack_channel[each.key].id
            tags       = local.slack_tags
          }
        }
      ]
    }
  ]
}

# Critical fan-out per project — fatal first-seen/regression in production
# also lands in #alerts-critical alongside Grafana criticals.
resource "sentry_alert" "slack_critical_fanout" {
  for_each = local.projects

  organization      = data.sentry_organization.main.internal_id
  name              = "${each.key} - Critical Fan-out (Slack)"
  environment       = "production"
  monitor_ids       = [data.sentry_project_issue_stream_monitor.default[each.key].id]
  frequency_minutes = 5

  trigger_conditions = [
    { first_seen_event = {} },
    { regression_event = {} },
  ]

  action_filters = [
    {
      logic_type = "all"
      conditions = [
        {
          level = {
            level = local.level_fatal
            match = "eq"
          }
        }
      ]
      actions = [
        {
          slack = {
            integration_id = data.sentry_organization_integration.slack.id
            channel_name   = var.slack_critical_channel
            tags           = local.slack_tags
          }
        }
      ]
    }
  ]
}

###########################
# Sentry Project References #
###########################
# Sentry projects are managed outside of Terraform — `data "sentry_all_projects"`
# in data.tf auto-discovers them, so creating a new project in the Sentry UI is
# all you need before re-running terraform apply. Terraform will then spin up
# the two `sentry_alert` rules plus the issue-stream monitor data source.
#
# The matching Slack channel (`#sentry-<project-slug>`) must be pre-created by
# a Slack admin AND the @Sentry OAuth bot invited to it before apply.
