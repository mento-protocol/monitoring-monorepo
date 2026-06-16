# GitHub repo Actions secrets consumed by the governance-watchdog drift leg
# in .github/workflows/terraform-drift.yml. Same mirror pattern and the same
# CKV_GIT_4 plaintext-value trade-off as alerts/infra/main.tf — state is
# encrypted at rest in GCS behind org-terraform impersonation.
#
# TF_VAR_BILLING_ACCOUNT, TF_VAR_QUICKNODE_API_KEY, and TF_VAR_GITHUB_TOKEN
# are deliberately NOT mirrored here: the alerts-delivery stack already owns
# those repo secrets, and a second stack managing the same secret name would
# fight it on every apply. This stack's tfvars must hold the same values.

locals {
  # Non-sensitive name set for for_each; sensitive values flow only through
  # the resource's `value` field (same split as alerts/infra/main.tf).
  gov_watchdog_ci_secret_names = toset([
    "TF_VAR_ORG_ID",
    "TF_VAR_DISCORD_WEBHOOK_URL",
    "TF_VAR_DISCORD_TEST_WEBHOOK_URL",
    "TF_VAR_TELEGRAM_CHAT_ID",
    "TF_VAR_TELEGRAM_TEST_CHAT_ID",
    "TF_VAR_TELEGRAM_BOT_TOKEN",
    "TF_VAR_X_AUTH_TOKEN",
    "TF_VAR_QUICKNODE_SECURITY_TOKEN",
    "TF_VAR_VICTOROPS_WEBHOOK_URL",
    "TF_VAR_SLACK_NOTIFICATION_CHANNEL_ID",
  ])

  gov_watchdog_ci_secret_values = {
    TF_VAR_ORG_ID                        = var.org_id
    TF_VAR_DISCORD_WEBHOOK_URL           = var.discord_webhook_url
    TF_VAR_DISCORD_TEST_WEBHOOK_URL      = var.discord_test_webhook_url
    TF_VAR_TELEGRAM_CHAT_ID              = var.telegram_chat_id
    TF_VAR_TELEGRAM_TEST_CHAT_ID         = var.telegram_test_chat_id
    TF_VAR_TELEGRAM_BOT_TOKEN            = var.telegram_bot_token
    TF_VAR_X_AUTH_TOKEN                  = var.x_auth_token
    TF_VAR_QUICKNODE_SECURITY_TOKEN      = var.quicknode_security_token
    TF_VAR_VICTOROPS_WEBHOOK_URL         = var.victorops_webhook_url
    TF_VAR_SLACK_NOTIFICATION_CHANNEL_ID = var.slack_notification_channel_id
  }
}

resource "github_actions_secret" "gov_watchdog_tf_vars" {
  # checkov:skip=CKV_GIT_4: plaintext `value` is the same state-backed
  # trade-off documented on alerts/infra's github_actions_secret resources.
  for_each    = local.gov_watchdog_ci_secret_names
  repository  = "monitoring-monorepo"
  secret_name = each.key
  value       = local.gov_watchdog_ci_secret_values[each.key]
}
