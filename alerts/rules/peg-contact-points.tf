resource "grafana_contact_point" "peg_market_warning" {
  for_each = local.peg_alert_instances

  name = local.peg_contact_point_names.market_warning

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_pools
    title     = local.peg_slack_title
    text      = local.peg_slack_message
  }

  depends_on = [
    grafana_message_template.peg_slack_title["peg-monitoring"],
    grafana_message_template.peg_slack_message["peg-monitoring"],
  ]
}

resource "grafana_contact_point" "peg_ops_warning" {
  for_each = local.peg_alert_instances

  name = local.peg_contact_point_names.ops_warning

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_infra
    title     = local.peg_slack_title
    text      = local.peg_slack_message
  }

  depends_on = [
    grafana_message_template.peg_slack_title["peg-monitoring"],
    grafana_message_template.peg_slack_message["peg-monitoring"],
  ]
}

resource "grafana_contact_point" "peg_page" {
  for_each = local.peg_alert_instances

  name = local.peg_contact_point_names.page

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
    grafana_message_template.peg_slack_title["peg-monitoring"],
    grafana_message_template.peg_slack_message["peg-monitoring"],
    grafana_message_template.peg_victorops_title["peg-monitoring"],
    grafana_message_template.peg_victorops_message["peg-monitoring"],
  ]
}

locals {
  peg_contact_point_names = {
    market_warning = "Peg market warnings (#alerts-pools)"
    ops_warning    = "Peg producer warnings (#alerts-infra)"
    page           = "Peg pages (Splunk On-Call + #alerts-critical)"
  }

  peg_notify_market_warning = {
    contact_point   = local.peg_contact_point_names.market_warning
    group_by        = ["alertname", "grafana_folder", "asset", "source", "policy_version"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }

  peg_notify_ops_warning = {
    contact_point   = local.peg_contact_point_names.ops_warning
    group_by        = ["alertname", "grafana_folder", "asset", "source", "policy_version"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }

  peg_notify_page = {
    contact_point   = local.peg_contact_point_names.page
    group_by        = ["alertname", "grafana_folder", "asset", "source", "policy_version"]
    group_wait      = "30s"
    group_interval  = "5m"
    repeat_interval = "1h"
  }
}
