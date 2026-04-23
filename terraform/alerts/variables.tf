variable "grafana_url" {
  type        = string
  description = "Grafana Cloud stack URL."
  default     = "https://clabsmento.grafana.net"
}

variable "grafana_service_account_token" {
  type        = string
  description = "Grafana Cloud service account token (glsa_...). Set in terraform.tfvars (gitignored). Rotate from Grafana Cloud → Administration → Service accounts."
  sensitive   = true
}

variable "slack_bot_token" {
  type        = string
  description = "Bot User OAuth Token (xoxb-...) for the Slack app that posts alert messages. Requires chat:write + chat:write.public scopes."
  sensitive   = true
}

variable "prometheus_datasource_uid" {
  type        = string
  description = "UID of the Grafana Cloud Prometheus datasource that stores v3 pool metrics."
  default     = "grafanacloud-prom"
}

variable "slack_channel_critical" {
  type        = string
  description = "Slack channel for page-worthy alerts."
  default     = "#alerts-critical"
}

variable "slack_channel_warnings" {
  type        = string
  description = "Slack channel for lower-severity alerts."
  default     = "#alerts-warnings"
}
