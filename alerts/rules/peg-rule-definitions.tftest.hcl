mock_provider "grafana" {}

run "peg_rule_definitions_create_one_enabled_consumer_set" {
  command = plan

  variables {
    grafana_service_account_token     = "test-grafana-token"
    slack_bot_token                   = "xoxb-test-token"
    splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
  }

  assert {
    condition     = local.peg_alerts_enabled == true && length(local.peg_alert_instances) == 1
    error_message = "Peg Grafana consumers must use one enabled singleton instance."
  }

  assert {
    condition     = length(grafana_folder.peg_monitoring) == 1 && length(grafana_rule_group.peg_monitoring) == 1
    error_message = "Peg activation must create exactly one Grafana folder and rule group."
  }

  assert {
    condition     = length(local.peg_rule_definitions) > 0
    error_message = "Peg rule definitions must evaluate with the enabled consumer set."
  }
}
