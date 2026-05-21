#############
# Providers #
#############

provider "sentry" {
  token = var.sentry_auth_token
}

provider "discord" {
  token = var.discord_bot_token
}

# Discord API provider
provider "restapi" {
  alias = "discord"
  uri   = "https://discord.com/api/v10"
  headers = {
    "Authorization" = "Bot ${var.discord_bot_token}"
    "Content-Type"  = "application/json"
  }
  write_returns_object = true
  debug                = var.debug_mode
}

# Google Cloud Provider
# Note: Project is NOT specified here to avoid circular dependency
# The project_factory module will create the project, and resources
# will specify the project explicitly when needed
provider "google" {
  impersonate_service_account = var.terraform_service_account
  region                      = var.region
}

# QuickNode REST API Provider
# Based on: https://www.quicknode.com/docs/webhooks/rest-api/webhooks/webhooks-rest-create-webhook
provider "restapi" {
  alias = "quicknode"
  uri   = "https://api.quicknode.com"
  headers = {
    "x-api-key"    = var.quicknode_api_key
    "Content-Type" = "application/json"
    "accept"       = "application/json"
  }
  write_returns_object = true
  debug                = var.debug_mode
}

