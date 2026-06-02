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

variable "splunk_on_call_alerts_webhook_url" {
  description = "Webhook URL for triggering Splunk On-Call alerts."
  type        = string
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
  description = "[DEPRECATED] Slack channel for lower-severity alerts. Retained for legacy warning-channel compatibility; remove after all v3 rules migrate to domain-specific channels."
  default     = "#alerts-warning"
}

variable "slack_channel_oracles" {
  type        = string
  description = "Slack channel for oracle health warnings (oracle liveness, oracle jump exceeds swap fee)."
  default     = "#alerts-oracles"
}

variable "slack_channel_pools" {
  type        = string
  description = "Slack channel for FPMM pool-mechanics warnings (deviation, rebalancer, trading-limit pressure)."
  default     = "#alerts-pools"
}

variable "slack_channel_infra" {
  type        = string
  description = "Slack channel for indexer and metrics-bridge warning alerts."
  default     = "#alerts-infra"
}

variable "slack_channel_cdps" {
  type        = string
  description = "Slack channel for CDP (Liquity v2) warning alerts (stability-pool thinning, liquidation/redemption activity)."
  default     = "#alerts-cdps"
}

variable "slack_channel_reserve" {
  type        = string
  description = "Slack channel for reserve balance warning alerts."
  default     = "#alerts-reserve"
}

variable "slack_channel_testnet" {
  type        = string
  description = "Slack channel for all non-prod alerts (celo-sepolia, monad-testnet)."
  default     = "#alerts-testnet"
}
