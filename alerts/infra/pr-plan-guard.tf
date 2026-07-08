###################################
# PR-safe Terraform plan sentinel #
###################################
#
# The alerts-delivery stack owns several providers whose configuration performs
# authenticated API checks or reads: Sentry, Slack, QuickNode, and GitHub. Pull
# request plans intentionally receive dummy TF_VAR values for those credentials.
# The PR workflow targets this built-in Terraform resource alongside the
# GCP-only onchain event handler module instead of the full provider graph. That
# keeps the PR job exercising init/validate/plan with no production secrets in
# the environment; push/dispatch plans and gated applies still run the full
# graph with real credentials.

resource "terraform_data" "pr_plan_secretless_guard" {
  input = {
    stack   = "alerts-infra"
    purpose = "secretless-pr-plan"
  }
}
