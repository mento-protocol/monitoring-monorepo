variable "project_name" {
  type = string
  # Can be at most 26 characters long
  default = "governance-watchdog"
}

variable "region" {
  type    = string
  default = "europe-west1"
}

# You can find our org id via `gcloud organizations list`
variable "org_id" {
  type = string
  # Same Mento GCP org as every other stack (alerts/infra hardcodes this exact
  # default). Defaulted so CI needs no TF_VAR_org_id env var: a bare,
  # workspace-wide TF_VAR_org_id in terraform-drift.yml would expand empty
  # pre-bootstrap and clobber the alerts-delivery leg, which also declares
  # org_id with its own matching default.
  default = "599540483579"
}

# You can find the billing account via `gcloud billing accounts list` (pick the GmbH account)
variable "billing_account" {
  type = string

  validation {
    condition     = length(trimspace(var.billing_account)) > 0
    error_message = "Billing account must not be empty."
  }
}

variable "function_name" {
  type    = string
  default = "watchdog-notifications"
}

variable "function_entry_point" {
  type    = string
  default = "governanceWatchdog"
}

# Mirrors the sibling alerts/infra/onchain-event-handler and oncall-announcer
# modules' variable names for consistency. Defaults match current behavior so
# the only plan diff from parametrizing is the new instance bounds below.
variable "memory_mb" {
  description = "Memory allocation for the function in MB"
  type        = number
  default     = 512
}

variable "timeout_seconds" {
  description = "Cloud Function timeout in seconds"
  type        = number
  default     = 60
}

variable "min_instances" {
  description = "Minimum number of Cloud Function instances"
  type        = number
  default     = 0
}

# Single QuickNode webhook stream (governance events only, low volume) with no
# fan-out to other consumers. Capped low so a webhook flood or misconfigured
# retry storm can't scale cost unbounded, mirroring the "keep this low" intent
# on the sibling functions' max_instances default.
variable "max_instances" {
  description = "Maximum number of Cloud Function instances. Keep this low; a single QuickNode webhook stream should never need to burst wide, and an unbounded cap would let a webhook flood or retry storm scale cost without limit."
  type        = number
  default     = 3
}

# You can look this up via:
#  `gcloud secrets list`
variable "discord_webhook_url_secret_id" {
  type    = string
  default = "discord-webhook-url"
}

variable "discord_test_webhook_url_secret_id" {
  type    = string
  default = "discord-test-webhook-url"
}

# You can look this up either on the Discord Channel settings, or fetch it from Secret Manager via:
#  `gcloud secrets versions access latest --secret discord-webhook-url`
variable "discord_webhook_url" {
  type      = string
  sensitive = true

  validation {
    condition     = length(trimspace(var.discord_webhook_url)) > 0
    error_message = "Discord webhook URL must not be empty."
  }
}

# You can look this up either on the Discord Channel settings, or fetch it from Secret Manager via:
#  `gcloud secrets versions access latest --secret discord-test-webhook-url`
variable "discord_test_webhook_url" {
  type      = string
  sensitive = true

  validation {
    condition     = length(trimspace(var.discord_test_webhook_url)) > 0
    error_message = "Discord test webhook URL must not be empty."
  }
}

# You can look this up by inviting @MissRose_bot to the telegram group and then calling the `/id` command (please remove the bot after you're done)
variable "telegram_chat_id" {
  type = string

  validation {
    condition     = length(trimspace(var.telegram_chat_id)) > 0
    error_message = "Telegram chat ID must not be empty."
  }
}

# You can look this up by inviting @MissRose_bot to the telegram group and then calling the `/id` command (please remove the bot after you're done)
variable "telegram_test_chat_id" {
  type = string

  validation {
    condition     = length(trimspace(var.telegram_test_chat_id)) > 0
    error_message = "Telegram test chat ID must not be empty."
  }
}

# You can look this up via:
#  `gcloud secrets list`
variable "telegram_bot_token_secret_id" {
  type    = string
  default = "telegram-bot-token"
}

# You can look this up via:
#  `gcloud secrets versions access latest --secret telegram-bot-token`
variable "telegram_bot_token" {
  type      = string
  sensitive = true

  validation {
    condition     = length(trimspace(var.telegram_bot_token)) > 0
    error_message = "Telegram bot token must not be empty."
  }
}

# You can create an API key via the QuickNode dashboard at https://dashboard.quicknode.com/api-keys
variable "quicknode_api_key" {
  type      = string
  sensitive = true

  validation {
    condition     = length(trimspace(var.quicknode_api_key)) > 0
    error_message = "QuickNode API key must not be empty."
  }
}

# You can look this up via:
#  `gcloud secrets list`
variable "quicknode_api_key_secret_id" {
  type    = string
  default = "quicknode-api-key"
}

# You can look this up via:
#  `gcloud secrets list`
variable "quicknode_security_token_secret_id" {
  type    = string
  default = "quicknode-security-token"
}

# You can look this up via:
#  `gcloud secrets list`
variable "x_auth_token_secret_id" {
  type    = string
  default = "x-auth-token"
}

variable "x_auth_token" {
  type      = string
  sensitive = true

  validation {
    condition     = length(trimspace(var.x_auth_token)) > 0
    error_message = "x-auth-token must not be empty."
  }
}

variable "quicknode_security_token" {
  type        = string
  sensitive   = true
  description = "Security token for QuickNode webhook authentication"

  validation {
    condition     = length(trimspace(var.quicknode_security_token)) > 0
    error_message = "QuickNode security token must not be empty."
  }
}

# Webhook URL to send monitoring alerts from within GCP Monitoring
# You can find this URL in Victorops by going to "Integrations" -> "Stackdriver".
# The routing key can be found under "Settings" -> "Routing Keys"
variable "victorops_webhook_url" {
  type      = string
  sensitive = true

  validation {
    condition     = length(trimspace(var.victorops_webhook_url)) > 0
    error_message = "VictorOps webhook URL must not be empty."
  }
}

# Slack notification channel ID for error alerts.
# This is the ID of the notification channel created via OAuth in GCP Console.
# To find this ID:
# 1. Go to GCP Console → Monitoring → Alerting → Edit Notification Channels
# 2. Click on the Slack channel and copy the ID from the URL or run:
#    gcloud beta monitoring channels list --format='table(name,displayName,type)'
# Note: Leave empty for initial deployment; the channel can only be created after the GCP project exists.
variable "slack_notification_channel_id" {
  type        = string
  description = "The notification channel ID for Slack (e.g., '7755148860700532944')"
  default     = ""
}

# Used to impersonate our Terraform service account in the Google provider
variable "terraform_service_account" {
  type        = string
  description = "Service account of our Terraform GCP Project which can be impersonated to create and destroy resources in this project"
  default     = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}

# For consistency we also keep this variable in here, although it's not used in the Terraform code (only in the shell scripts)
variable "terraform_seed_project_id" {
  type        = string
  description = "The GCP Project ID of the Terraform Seed Project housing the terraform state of all projects"
  default     = "mento-terraform-seed-ffac"
}

variable "github_token" {
  description = "Fine-grained GitHub PAT scoped to monitoring-monorepo with Secrets read/write. Used to mirror the TF_VAR_* repo secrets consumed by the drift workflow."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.github_token) > 0
    error_message = "GitHub PAT must not be empty."
  }
}
