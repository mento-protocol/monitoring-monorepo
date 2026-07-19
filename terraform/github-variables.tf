# GitHub repo Actions variables (as opposed to secrets — see
# `github-secrets.tf`) managed by the platform stack.
#
# Terraform-apply Slack channel routing
# ───────────────────────────────────────
#
# `.github/workflows/{governance-watchdog,aegis-terraform,alerts-infra,
# alerts-rules}.yml` each read `vars.TERRAFORM_APPLY_SLACK_CHANNEL` (falling
# back to a hardcoded `#deploys` when the variable is unset) to choose
# where `scripts/notify-terraform-apply.mjs` posts its apply-pending
# summary. Before this resource, that fallback only existed as duplicated
# workflow YAML; this makes the routing an explicit, versioned GitHub
# Actions variable instead.
#
# `var.terraform_apply_slack_channel` defaults to the same `#deploys`
# value the workflows already fall back to, so the first apply of this
# resource does not change where the notification posts. An operator
# reroutes it by setting the tfvar and re-applying this (manual-apply)
# stack — see `docs/notes/slack-github-subscriptions.md`. The notify bot
# reaches any public channel via its `chat:write.public` scope; a private
# target channel needs a one-time manual `/invite` (the Slack API can't
# self-join private channels).

resource "github_actions_variable" "terraform_apply_slack_channel" {
  repository    = "monitoring-monorepo"
  variable_name = "TERRAFORM_APPLY_SLACK_CHANNEL"
  value         = var.terraform_apply_slack_channel
}

# Sentry triage/autofix kill switch
# ───────────────────────────────────
#
# `SENTRY_TRIAGE_ENABLED` is the ADR 0036 / ADR 0030 kill switch for the
# scheduled Sentry triage/autofix workflows. Those workflows read this repo
# variable and no-op unless it equals "true", so the pipeline stays inert after
# its secrets are provisioned until an operator deliberately activates it.
#
# Unlike the `count`-gated secret mirrors in `github-secrets.tf`, this resource
# is unconditional so the kill switch always exists for the workflows to read;
# `var.sentry_triage_enabled` defaults to "false", so the first apply provisions
# the switch in its off position. Activation is a follow-up tfvar change to
# "true" plus a re-apply (still IaC, not the GitHub UI), done only after both
# Phase-1 workflow PRs are merged and the two tokens are provisioned. Runbook:
# `docs/notes/sentry-triage-pipeline.md`.

resource "github_actions_variable" "sentry_triage_enabled" {
  repository    = "monitoring-monorepo"
  variable_name = "SENTRY_TRIAGE_ENABLED"
  value         = var.sentry_triage_enabled
}

# Sentry autofix (Phase 2b) App ID + kill switch
# ────────────────────────────────────────────────
#
# `AUTOFIX_APP_ID` is the non-secret half of the `sentry-autofix` GitHub App
# credential (the PEM key is the secret `AUTOFIX_APP_PRIVATE_KEY` in
# `github-secrets.tf`). The autofix workflow's select job no-ops unless this
# variable AND the two autofix secrets are all present, so it is `count`-gated
# on the tfvar being non-empty exactly like the secret mirrors — the App ID is
# only known after the operator creates the App, and gating keeps plan/apply
# green before then.
resource "github_actions_variable" "autofix_app_id" {
  count = var.autofix_app_id == "" ? 0 : 1

  repository    = "monitoring-monorepo"
  variable_name = "AUTOFIX_APP_ID"
  value         = var.autofix_app_id
}

# `SENTRY_AUTOFIX_ENABLED` is the ADR 0036 Phase 2b kill switch for the
# scheduled autofix workflow — separate from `SENTRY_TRIAGE_ENABLED` so the
# read-only triage pipeline and the PR-writing autofix leg activate
# independently. Unconditional (like `sentry_triage_enabled`) so the switch
# always exists for the workflow to read; `var.sentry_autofix_enabled` defaults
# to "false", so the first apply provisions it off. Activation is a follow-up
# tfvar change to "true" plus a re-apply, done only after this workflow PR
# merges and the App is provisioned. Runbook:
# `docs/notes/sentry-triage-pipeline.md`.
resource "github_actions_variable" "sentry_autofix_enabled" {
  repository    = "monitoring-monorepo"
  variable_name = "SENTRY_AUTOFIX_ENABLED"
  value         = var.sentry_autofix_enabled
}
