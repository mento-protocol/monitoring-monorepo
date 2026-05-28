resource "grafana_contact_point" "splunk_on_call" {
  name = "Splunk On-Call"

  victorops {
    url         = var.splunk_on_call_alerts_webhook_url
    title       = local.alert_config_victorops.title
    description = local.alert_config_victorops.message
  }
}

# All six points share `local.alert_config_slack` which dispatches by
# alertname to the `slack.*` message templates in message-templates-slack.tf.

resource "grafana_contact_point" "slack_alerts_critical" {
  name = "Slack #alerts-critical"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_critical
    title     = local.alert_config_slack.title
    text      = local.alert_config_slack.message
  }
}

resource "grafana_contact_point" "slack_alerts_oracles" {
  name = "Slack #alerts-oracles"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_oracles
    title     = local.alert_config_slack.title
    text      = local.alert_config_slack.message
  }
}

resource "grafana_contact_point" "slack_alerts_pools" {
  name = "Slack #alerts-pools"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_pools
    title     = local.alert_config_slack.title
    text      = local.alert_config_slack.message
  }
}

resource "grafana_contact_point" "slack_alerts_reserve" {
  name = "Slack #alerts-reserve"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_reserve
    title     = local.alert_config_slack.title
    text      = local.alert_config_slack.message
  }
}

resource "grafana_contact_point" "slack_alerts_infra" {
  name = "Slack #alerts-infra"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_infra
    title     = local.alert_config_slack.title
    text      = local.alert_config_slack.message
  }
}

resource "grafana_contact_point" "slack_alerts_testnet" {
  name = "Slack #alerts-testnet"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_testnet
    title     = local.alert_config_slack.title
    text      = local.alert_config_slack.message
  }
}
