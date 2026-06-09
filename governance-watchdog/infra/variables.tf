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
}

# You can find the billing account via `gcloud billing accounts list` (pick the GmbH account)
variable "billing_account" {
  type = string
}

variable "function_name" {
  type    = string
  default = "watchdog-notifications"
}

variable "function_entry_point" {
  type    = string
  default = "governanceWatchdog"
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
}

# You can look this up either on the Discord Channel settings, or fetch it from Secret Manager via:
#  `gcloud secrets versions access latest --secret discord-test-webhook-url`
variable "discord_test_webhook_url" {
  type      = string
  sensitive = true
}

# You can look this up by inviting @MissRose_bot to the telegram group and then calling the `/id` command (please remove the bot after you're done)
variable "telegram_chat_id" {
  type = string
}

# You can look this up by inviting @MissRose_bot to the telegram group and then calling the `/id` command (please remove the bot after you're done)
variable "telegram_test_chat_id" {
  type = string
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
}

# You can create an API key via the QuickNode dashboard at https://dashboard.quicknode.com/api-keys
variable "quicknode_api_key" {
  type      = string
  sensitive = true
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
}

variable "quicknode_security_token" {
  type        = string
  sensitive   = true
  description = "Security token for QuickNode webhook authentication"
}

# Webhook URL to send monitoring alerts from within GCP Monitoring
# You can find this URL in Victorops by going to "Integrations" -> "Stackdriver".
# The routing key can be found under "Settings" -> "Routing Keys"
variable "victorops_webhook_url" {
  type      = string
  sensitive = true
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
# trunk-ignore(tflint/terraform_unused_declarations)
variable "terraform_seed_project_id" {
  type        = string
  description = "The GCP Project ID of the Terraform Seed Project housing the terraform state of all projects"
  default     = "mento-terraform-seed-ffac"
}
