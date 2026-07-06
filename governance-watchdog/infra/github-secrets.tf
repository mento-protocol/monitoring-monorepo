# GitHub repo Actions secrets consumed by the governance-watchdog drift leg
# in .github/workflows/terraform-drift.yml. Same mirror pattern and the same
# CKV_GIT_4 plaintext-value trade-off as alerts/infra/main.tf — state is
# encrypted at rest in GCS behind org-terraform impersonation.
#
# Terraform can detect a missing github_actions_secret, but the GitHub API never
# returns secret values after creation. Drift plans therefore cannot detect
# out-of-band value edits; they only prove the expected secret names exist.
#
# TF_VAR_BILLING_ACCOUNT, TF_VAR_QUICKNODE_API_KEY, TF_VAR_GITHUB_TOKEN, and
# TF_VAR_SLACK_NOTIFICATION_CHANNEL_ID are deliberately NOT mirrored here:
# alerts-delivery / alerts/infra already own those repo secrets, and a second
# stack managing the same secret name would fight it on every apply. The
# governance-watchdog QuickNode API key and Slack channel are project-specific,
# so they are mirrored under TF_VAR_GOVERNANCE_WATCHDOG_QUICKNODE_API_KEY and
# TF_VAR_GOVERNANCE_WATCHDOG_SLACK_NOTIFICATION_CHANNEL_ID, then exported under
# the Terraform variable names only in the governance-watchdog workflow legs.
# The drift workflow keeps the pre-existing workflow-level Slack value as a
# transition fallback only until this stack-specific secret has been mirrored.
# This stack's tfvars must hold the same shared Billing/GitHub values.

locals {
  # Non-sensitive name set for for_each; sensitive values flow only through
  # the resource's `value` field (same split as alerts/infra/main.tf).
  gov_watchdog_ci_base_secret_names = toset([
    "TF_VAR_ORG_ID",
    "TF_VAR_DISCORD_WEBHOOK_URL",
    "TF_VAR_DISCORD_TEST_WEBHOOK_URL",
    "TF_VAR_TELEGRAM_CHAT_ID",
    "TF_VAR_TELEGRAM_TEST_CHAT_ID",
    "TF_VAR_TELEGRAM_BOT_TOKEN",
    "TF_VAR_X_AUTH_TOKEN",
    "TF_VAR_GOVERNANCE_WATCHDOG_QUICKNODE_API_KEY",
    "TF_VAR_QUICKNODE_SECURITY_TOKEN",
    "TF_VAR_VICTOROPS_WEBHOOK_URL",
  ])
  gov_watchdog_ci_slack_secret_names = var.slack_notification_channel_id != "" ? toset([
    "TF_VAR_GOVERNANCE_WATCHDOG_SLACK_NOTIFICATION_CHANNEL_ID",
  ]) : toset([])
  gov_watchdog_ci_secret_names = setunion(
    local.gov_watchdog_ci_base_secret_names,
    local.gov_watchdog_ci_slack_secret_names,
  )

  gov_watchdog_ci_secret_values = {
    TF_VAR_ORG_ID                                            = var.org_id
    TF_VAR_DISCORD_WEBHOOK_URL                               = var.discord_webhook_url
    TF_VAR_DISCORD_TEST_WEBHOOK_URL                          = var.discord_test_webhook_url
    TF_VAR_TELEGRAM_CHAT_ID                                  = var.telegram_chat_id
    TF_VAR_TELEGRAM_TEST_CHAT_ID                             = var.telegram_test_chat_id
    TF_VAR_TELEGRAM_BOT_TOKEN                                = var.telegram_bot_token
    TF_VAR_X_AUTH_TOKEN                                      = var.x_auth_token
    TF_VAR_GOVERNANCE_WATCHDOG_QUICKNODE_API_KEY             = var.quicknode_api_key
    TF_VAR_QUICKNODE_SECURITY_TOKEN                          = var.quicknode_security_token
    TF_VAR_VICTOROPS_WEBHOOK_URL                             = var.victorops_webhook_url
    TF_VAR_GOVERNANCE_WATCHDOG_SLACK_NOTIFICATION_CHANNEL_ID = var.slack_notification_channel_id
  }
}

removed {
  # Earlier revisions briefly used this resource address to mirror the
  # alerts-owned TF_VAR_SLACK_NOTIFICATION_CHANNEL_ID secret. Drop the whole old
  # state binding without deleting any live repo secrets; the desired
  # governance-watchdog-owned secrets are recreated below under a new address.
  from = github_actions_secret.gov_watchdog_tf_vars

  lifecycle {
    destroy = false
  }
}

resource "github_actions_secret" "gov_watchdog_stack_tf_vars" {
  # checkov:skip=CKV_GIT_4: plaintext `value` is the same state-backed
  # trade-off documented on alerts/infra's github_actions_secret resources.
  for_each    = local.gov_watchdog_ci_secret_names
  repository  = "monitoring-monorepo"
  secret_name = each.key
  value       = local.gov_watchdog_ci_secret_values[each.key]
}
