#############
# Providers #
#############

provider "sentry" {
  token = var.sentry_auth_token
}

provider "discord" {
  token = var.discord_bot_token
}

# GitHub provider — used solely to push the `TF_VAR_*` repo secrets that
# `.github/workflows/alerts-infra.yml` consumes (see `github_actions_secret`
# resources in `main.tf`). The PAT in `var.github_token` should be
# fine-grained, scoped to this single repo, with `Secrets: Read and write`
# permission only — that's the least-privilege grant for managing repo
# Actions secrets.
provider "github" {
  token = var.github_token
  owner = "mento-protocol"
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

# Slack Web API provider — used by the sentry-bridge module to create and
# archive the per-project `#sentry-<slug>` channels via `conversations.create`
# and `conversations.archive`. Slack returns 200 OK on logical errors with
# `{"ok": false, "error": "..."}`, so every restapi_object using this provider
# MUST guard with a `lifecycle.postcondition` that asserts `.ok == true`.
provider "restapi" {
  alias = "slack"
  uri   = "https://slack.com/api"
  headers = {
    "Authorization" = "Bearer ${var.slack_bot_token}"
    "Content-Type"  = "application/json; charset=utf-8"
  }
  write_returns_object = true
  debug                = var.debug_mode
}

