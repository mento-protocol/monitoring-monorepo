mock_provider "grafana" {}

# Pin Synthetic Monitoring off so CI's TF_VAR_synthetic_monitoring_access_token
# cannot change what this file plans. synthetic-monitoring.tftest.hcl covers
# the enabled path with mocked probes.
variables {
  synthetic_monitoring_access_token = ""
  grafana_service_account_token     = "fixture"
  slack_bot_token                   = "fixture"
  oncall_support_usergroup_id       = "S012345678"
  splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
}

run "breaker_halts_page_at_most_once_a_day_per_feed" {
  command = plan

  # One pager rule per prod chain, held open for a day after the last halt.
  assert {
    condition = length([
      for r in grafana_rule_group.trading_modes.rule : r
      if startswith(r.name, "Trading Mode Page [") &&
      r.keep_firing_for == "24h" &&
      r.labels["route"] == "pager" &&
      r.labels["severity"] == "page"
    ]) == length(local.prod_chains)
    error_message = "Each prod chain needs one \"Trading Mode Page\" rule with keep_firing_for 24h and labels route=pager, severity=page."
  }

  # The real-time rules never carry the pager label, so they stay out of Splunk.
  assert {
    condition = alltrue([
      for r in grafana_rule_group.trading_modes.rule :
      lookup(r.labels, "route", "") != "pager"
      if startswith(r.name, "Trading Mode Alert [")
    ])
    error_message = "\"Trading Mode Alert\" rules must not carry route=pager: they feed Slack, not the pager."
  }

  # Every Splunk route for service=exchanges requires route=pager, repeats
  # daily and is terminal.
  assert {
    condition = length([
      for p in grafana_notification_policy.all.policy[0].policy : p
      if p.contact_point == grafana_contact_point.splunk_on_call.name &&
      length([for m in p.matcher : m if m.label == "service" && m.value == "exchanges"]) == 1 &&
      length([for m in p.matcher : m if m.label == "route" && m.match == "=" && m.value == "pager"]) == 1 &&
      p.repeat_interval == "1d" &&
      !p.continue
    ]) == length(local.prod_chains)
    error_message = "Each prod chain needs one terminal Splunk route for service=exchanges that matches route=pager and repeats every 1d."
  }

  assert {
    condition = length([
      for p in grafana_notification_policy.all.policy[0].policy : p
      if p.contact_point == grafana_contact_point.splunk_on_call.name &&
      length([for m in p.matcher : m if m.label == "service" && m.value == "exchanges"]) == 1
    ]) == length(local.prod_chains)
    error_message = "No Splunk route for service=exchanges may exist without the route=pager matcher."
  }
}
