mock_provider "grafana" {}

run "peg_rule_definitions_evaluate_before_activation" {
  command = plan

  variables {
    grafana_service_account_token     = "test-grafana-token"
    slack_bot_token                   = "xoxb-test-token"
    splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
  }

  assert {
    condition     = local.peg_alerts_enabled == false && length(local.peg_alert_instances) == 0
    error_message = "Peg Grafana consumers must remain disabled by default."
  }

  assert {
    condition     = length(local.peg_rule_definitions) > 0
    error_message = "Peg rule definitions must evaluate before a reviewed source change enables their consumers."
  }
}
