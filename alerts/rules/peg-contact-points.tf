resource "grafana_contact_point" "peg_market_warning" {
  name = "Peg market warnings (#alerts-pools)"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_pools
    title     = local.peg_slack_title
    text      = local.peg_slack_message
  }

  depends_on = [
    grafana_message_template.peg_slack_title,
    grafana_message_template.peg_slack_message,
  ]
}

resource "grafana_contact_point" "peg_ops_warning" {
  name = "Peg producer warnings (#alerts-infra)"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_infra
    title     = local.peg_slack_title
    text      = local.peg_slack_message
  }

  depends_on = [
    grafana_message_template.peg_slack_title,
    grafana_message_template.peg_slack_message,
  ]
}

resource "grafana_contact_point" "peg_page" {
  name = "Peg pages (Splunk On-Call + #alerts-critical)"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_critical
    title     = local.peg_slack_title
    text      = local.peg_slack_message
  }

  victorops {
    url         = var.splunk_on_call_alerts_webhook_url
    title       = local.peg_victorops_title
    description = local.peg_victorops_message
  }

  depends_on = [
    grafana_message_template.peg_slack_title,
    grafana_message_template.peg_slack_message,
    grafana_message_template.peg_victorops_title,
    grafana_message_template.peg_victorops_message,
  ]
}

locals {
  peg_notify_market_warning = {
    contact_point   = grafana_contact_point.peg_market_warning.name
    group_by        = ["alertname", "grafana_folder", "asset", "source", "policy_version"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }

  peg_notify_ops_warning = {
    contact_point   = grafana_contact_point.peg_ops_warning.name
    group_by        = ["alertname", "grafana_folder", "asset", "source", "policy_version"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }

  peg_notify_page = {
    contact_point   = grafana_contact_point.peg_page.name
    group_by        = ["alertname", "grafana_folder", "asset", "source", "policy_version"]
    group_wait      = "30s"
    group_interval  = "5m"
    repeat_interval = "1h"
  }
}
