mock_provider "grafana" {}

run "trading_limit_slack_routes_post_once" {
  command = plan

  variables {
    grafana_service_account_token     = "fixture"
    slack_bot_token                   = "fixture"
    oncall_support_usergroup_id       = "S012345678"
    splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
  }

  assert {
    condition = length([
      for p in grafana_notification_policy.all.policy[0].policy : p
      if p.contact_point != grafana_contact_point.splunk_on_call.name &&
      length([for m in p.matcher : m if m.label == "service" && m.match == "=" && m.value == "trading-limits"]) == 1 &&
      p.repeat_interval == "8760h"
    ]) == 2
    error_message = "Both Slack trading-limit routes (#alerts-critical and #alerts-pools) must post once: repeat_interval 8760h."
  }
}
