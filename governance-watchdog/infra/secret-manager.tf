# Creates a new secret for the Discord webhook URL.
# Terraform will try to look up the webhook URL from terraform.tfvars,
# and if it can't find it locally it will prompt the user to enter it manually.
resource "google_secret_manager_secret" "discord_webhook_url" {
  project   = module.governance_watchdog.project_id
  secret_id = var.discord_webhook_url_secret_id

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "discord_webhook_url" {
  secret      = google_secret_manager_secret.discord_webhook_url.id
  secret_data = var.discord_webhook_url
}


# Creates a new secret for the Test Discord webhook URL.
# Terraform will try to look up the webhook URL from terraform.tfvars,
# and if it can't find it locally it will prompt the user to enter it manually.
resource "google_secret_manager_secret" "discord_test_webhook_url" {
  project   = module.governance_watchdog.project_id
  secret_id = var.discord_test_webhook_url_secret_id

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "discord_test_webhook_url" {
  secret      = google_secret_manager_secret.discord_test_webhook_url.id
  secret_data = var.discord_test_webhook_url
}

# Creates a new secret for the Telegram Bot Token.
resource "google_secret_manager_secret" "telegram_bot_token" {
  project   = module.governance_watchdog.project_id
  secret_id = var.telegram_bot_token_secret_id

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "telegram_bot_token" {
  secret      = google_secret_manager_secret.telegram_bot_token.id
  secret_data = var.telegram_bot_token
}

# Creates a new secret for the x-auth-token header, which is used to authenticate requests of origin other than Quicknode.
resource "google_secret_manager_secret" "x_auth_token" {
  project   = module.governance_watchdog.project_id
  secret_id = var.x_auth_token_secret_id

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "x_auth_token" {
  secret      = google_secret_manager_secret.x_auth_token.id
  secret_data = var.x_auth_token
}

# Creates a new secret for the Quicknode Security Token which is used to verify that requests to the Cloud Function are coming from Quicknode.
resource "google_secret_manager_secret" "quicknode_security_token" {
  project   = module.governance_watchdog.project_id
  secret_id = "quicknode-security-token"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "quicknode_security_token" {
  secret      = google_secret_manager_secret.quicknode_security_token.id
  secret_data = var.quicknode_security_token
}

# Creates a new secret for the QuickNode API key which is used to query the QuickNode REST API
# for webhook health status monitoring.
resource "google_secret_manager_secret" "quicknode_api_key" {
  project   = module.governance_watchdog.project_id
  secret_id = "quicknode-api-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "quicknode_api_key" {
  secret      = google_secret_manager_secret.quicknode_api_key.id
  secret_data = var.quicknode_api_key
}
