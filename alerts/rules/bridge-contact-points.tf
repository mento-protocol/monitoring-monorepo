variable "slack_channel_bridges" {
  type        = string
  description = "Bridge-transfer warning destination. Channel lifecycle belongs to alerts-delivery."
  default     = "#alerts-bridges"
}

resource "grafana_contact_point" "bridge_warning" {
  name = "slack-alerts-bridges"
  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_bridges
    title     = local.bridge_notification_title
    text      = local.bridge_notification_body
  }
}

resource "grafana_contact_point" "bridge_page" {
  name = "Bridge pages (Splunk On-Call + #alerts-critical)"
  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_critical
    title     = local.bridge_notification_title
    text      = local.bridge_notification_body
  }
  victorops {
    url         = var.splunk_on_call_alerts_webhook_url
    title       = local.bridge_notification_title
    description = local.bridge_notification_body
  }
}

resource "grafana_contact_point" "bridge_infra" {
  name = "Bridge observations (#alerts-infra)"
  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_infra
    title     = local.bridge_notification_title
    text      = local.bridge_notification_body
  }
}
