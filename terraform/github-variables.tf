# GitHub repo Actions variables (as opposed to secrets — see
# `github-secrets.tf`) managed by the platform stack.
#
# Terraform-apply Slack channel routing
# ───────────────────────────────────────
#
# `.github/workflows/{governance-watchdog,aegis-terraform,alerts-infra,
# alerts-rules}.yml` each read `vars.TERRAFORM_APPLY_SLACK_CHANNEL` (falling
# back to a hardcoded `#ci-operations` when the variable is unset) to choose
# where `scripts/notify-terraform-apply.mjs` posts its apply-pending
# summary. Before this resource, that fallback only existed as duplicated
# workflow YAML; this makes the routing an explicit, versioned GitHub
# Actions variable instead.
#
# `var.terraform_apply_slack_channel` defaults to the same `#ci-operations`
# value the workflows already fall back to, so the first apply of this
# resource does not change where the notification posts. An operator
# reroutes it by setting the tfvar and re-applying this (manual-apply)
# stack — see `docs/notes/slack-github-subscriptions.md` for the
# accompanying bot-membership step (`alerts/infra`'s
# `deploy_notification_channel_id`) needed for private channels or channels
# the bot has not otherwise joined.

resource "github_actions_variable" "terraform_apply_slack_channel" {
  repository    = "monitoring-monorepo"
  variable_name = "TERRAFORM_APPLY_SLACK_CHANNEL"
  value         = var.terraform_apply_slack_channel
}
