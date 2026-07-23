# GitHub repo Actions variables (as opposed to secrets — see
# `github-secrets.tf`) managed by the platform stack.
#
# Terraform CI identity routing
# ──────────────────────────────
#
# Provider resource names and service-account emails are identifiers, not
# credentials. Keep them as IaC-owned repository variables and publish them only
# after the platform-owned IAM chains exist in the same reviewed apply.
resource "github_actions_variable" "gcp_production_infra_workload_identity_provider" {
  repository    = "monitoring-monorepo"
  variable_name = "GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER"
  value         = google_iam_workload_identity_pool_provider.github_production_infra.name

  depends_on = [
    google_service_account_iam_member.production_infra_applier_wif_binding,
    google_service_account_iam_member.production_infra_applier_org_terraform_token_creator,
  ]
}

resource "github_actions_variable" "gcp_production_infra_service_account" {
  repository    = "monitoring-monorepo"
  variable_name = "GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT"
  value         = google_service_account.production_infra_applier.email

  depends_on = [
    google_service_account_iam_member.production_infra_applier_wif_binding,
    google_service_account_iam_member.production_infra_applier_org_terraform_token_creator,
  ]
}

resource "github_actions_variable" "gcp_terraform_refresh_service_account" {
  repository    = "monitoring-monorepo"
  variable_name = "GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT"
  value         = google_service_account.terraform_refresh_readonly.email

  depends_on = [
    google_service_account_iam_member.terraform_refresh_readonly_wif_binding,
    google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator,
    google_storage_bucket_iam_member.state_bucket_refresh_readonly,
  ]
}

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

# Sentry triage archive kill switch (Phase 2a)
# ──────────────────────────────────────────────
#
# `SENTRY_ARCHIVE_ENABLED` is the ADR 0036 / ADR 0030 kill switch for the
# human-approved Sentry archive workflow (`.github/workflows/
# sentry-triage-archive.yml`). That workflow reads this repo variable and
# no-ops unless it equals "true", so the archive leg stays inert after its
# write-scoped token is provisioned until an operator deliberately activates it.
#
# Like `sentry_triage_enabled`, this resource is unconditional so the switch
# always exists for the workflow to read; `var.sentry_archive_enabled` defaults
# to "false", so the first apply provisions the switch in its off position.
# Activation is a follow-up tfvar change to "true" plus a re-apply (still IaC,
# not the GitHub UI). Runbook: `docs/notes/sentry-triage-pipeline.md`.

resource "github_actions_variable" "sentry_archive_enabled" {
  repository    = "monitoring-monorepo"
  variable_name = "SENTRY_ARCHIVE_ENABLED"
  value         = var.sentry_archive_enabled
}
