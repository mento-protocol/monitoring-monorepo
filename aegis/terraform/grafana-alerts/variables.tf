# For variables whose values are passed in from the either the root module or a terraform.tfvars file
variable "grafana_service_account_token" {
  description = "Grafana Service Account Token allowing Terraform to manage Grafana resources on the Mento Stack"
  type        = string
  sensitive   = true
}

variable "oracle_relayers_folder" {
  description = "The grafana folder in which to create the oracle relayer alerts"
  type = object({
    uid = string
  })
}

variable "reserve_folder" {
  description = "The Reserve folder in which to create the Reserve balance alerts"
  type = object({
    uid = string
  })
}

variable "trading_modes_folder" {
  description = "The Trading Modes folder in which to create the Trading Mode alerts"
  type = object({
    uid = string
  })
}

variable "trading_limits_folder" {
  description = "The Trading Limits folder in which to create the Trading Limits alerts"
  type = object({
    uid = string
  })
}

variable "aegis_folder" {
  description = "The Aegis folder in which to create the Aegis service alerts"
  type = object({
    uid = string
  })
}

variable "discord_alerts_webhook_url_staging" {
  description = "Webhook URL for the Discord channel where alerts for staging oracle relayers are sent"
  type        = string
  sensitive   = true
}

variable "discord_alerts_webhook_url_prod" {
  description = "Webhook URL for the Discord channel where alerts for prod oracle relayers are sent"
  type        = string
  sensitive   = true
}

variable "discord_alerts_webhook_url_reserve" {
  description = "Webhook URL for the Discord channel where alerts for reserve balances are sent"
  type        = string
  sensitive   = true
}

variable "discord_alerts_webhook_url_trading_modes_staging" {
  description = "Webhook URL for the Discord channel where trading mode alerts on staging are sent"
  type        = string
  sensitive   = true
}

variable "discord_alerts_webhook_url_trading_modes_prod" {
  description = "Webhook URL for the Discord channel where trading mode alerts on production are sent"
  type        = string
  sensitive   = true
}

variable "discord_alerts_webhook_url_catch_all" {
  description = "Catch-all Webhook URL for the Discord channel where alerts without a configured contact point are sent"
  type        = string
  sensitive   = true
}

variable "discord_alerts_webhook_url_aegis" {
  description = "Webhook URL for the Discord channel where Aegis service alerts are sent"
  type        = string
  sensitive   = true
}

variable "discord_alerts_webhook_url_trading_limits" {
  description = "Webhook URL for the Discord channel where trading limits alerts are sent"
  type        = string
  sensitive   = true
}

variable "splunk_on_call_alerts_webhook_url" {
  description = "Webhook URL for triggering on-call alerts"
  type        = string
  sensitive   = true
}

variable "slack_bot_token" {
  description = "Slack Bot User OAuth Token (xoxb-...) used by Grafana to post alerts. Same bot as the v3 alerts in alerts/rules/."
  type        = string
  sensitive   = true
}

variable "slack_channel_critical" {
  description = "Slack channel for pager-tier Aegis alerts (severity=page)."
  type        = string
  default     = "#alerts-critical"
}

variable "slack_channel_oracles" {
  description = "Slack channel for oracle warning alerts (oracle-relayers, oracle liveness)."
  type        = string
  default     = "#alerts-oracles"
}

variable "slack_channel_pools" {
  description = "Slack channel for pool-mechanics warning alerts (trading-limits, trading-modes, deviation)."
  type        = string
  default     = "#alerts-pools"
}

variable "slack_channel_reserve" {
  description = "Slack channel for reserve balance warning alerts."
  type        = string
  default     = "#alerts-reserve"
}

variable "slack_channel_infra" {
  description = "Slack channel for infrastructure warning alerts (aegis service, metrics-bridge, indexer). The root catch-all moves here in the cutover PR; during the dual-route window it still lands in Discord #alerts-catch-all."
  type        = string
  default     = "#alerts-infra"
}

variable "slack_channel_testnet" {
  description = "Slack channel for all non-prod alerts (celo-sepolia, monad-testnet)."
  type        = string
  default     = "#alerts-testnet"
}
