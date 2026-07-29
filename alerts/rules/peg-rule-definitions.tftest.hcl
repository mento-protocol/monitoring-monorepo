mock_provider "grafana" {}

run "peg_rule_definitions_preserve_consumer_guard_invariant" {
  command = plan

  variables {
    grafana_service_account_token     = "test-grafana-token"
    slack_bot_token                   = "xoxb-test-token"
    splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
  }

  assert {
    condition     = local.peg_alerts_enabled ? length(local.peg_alert_instances) == 1 : length(local.peg_alert_instances) == 0
    error_message = "Peg Grafana consumers must use one instance when enabled and none when disabled."
  }

  assert {
    condition     = local.peg_alerts_enabled ? length(grafana_folder.peg_monitoring) == 1 && length(grafana_rule_group.peg_monitoring) == 1 : length(grafana_folder.peg_monitoring) == 0 && length(grafana_rule_group.peg_monitoring) == 0
    error_message = "Peg Grafana folder and rule group counts must follow the source-controlled consumer guard."
  }

  assert {
    condition     = length(local.peg_rule_definitions) > 0
    error_message = "Peg rule definitions must evaluate with the source-controlled consumer guard."
  }
}
