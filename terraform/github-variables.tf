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

resource "github_actions_variable" "gcp_terraform_refresh_workload_identity_provider" {
  repository    = "monitoring-monorepo"
  variable_name = "GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER"
  value         = google_iam_workload_identity_pool_provider.github_terraform_refresh.name

  depends_on = [
    google_service_account_iam_member.terraform_refresh_readonly_wif_binding,
    google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator,
    google_storage_bucket_iam_member.state_bucket_refresh_readonly,
  ]
}

resource "github_actions_variable" "gcp_peg_policy_publication_plan_service_account" {
  repository    = "monitoring-monorepo"
  variable_name = "GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT"
  value         = google_service_account.peg_policy_publication_plan.email

  depends_on = [
    google_service_account_iam_member.peg_policy_publication_plan_wif_binding,
    google_service_account_iam_member.peg_policy_publication_plan_reader_token_creator,
    google_storage_bucket_iam_member.state_bucket_peg_policy_publication_reader,
    google_storage_bucket_iam_policy.peg_policy,
  ]
}

# Terraform-apply Slack channel routing
# ───────────────────────────────────────
#
# `.github/workflows/{governance-watchdog,aegis-terraform,alerts-infra,
# alerts-rules}.yml` each read `vars.TERRAFORM_APPLY_SLACK_CHANNEL` (falling
# back to a hardcoded `#deploys` when the variable is unset) to choose
# where `scripts/terraform/notify-terraform-apply.mjs` posts its apply-pending
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
