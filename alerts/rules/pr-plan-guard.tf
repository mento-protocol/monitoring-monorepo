# Same-repo PR plans intentionally avoid the secret-backed Grafana notification
# graph. This built-in-provider guard keeps a minimal Terraform execution check
# in the targeted PR plan without placing production provider tokens in the PR
# job.
resource "terraform_data" "pr_plan_secretless_guard" {
  input = {
    grafana_url_is_https    = startswith(var.grafana_url, "https://")
    grafana_token_provided  = length(nonsensitive(var.grafana_service_account_token)) > 0
    slack_token_provided    = length(nonsensitive(var.slack_bot_token)) > 0
    splunk_webhook_is_https = startswith(nonsensitive(var.splunk_on_call_alerts_webhook_url), "https://")
  }
}
