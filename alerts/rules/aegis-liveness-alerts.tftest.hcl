mock_provider "grafana" {}

run "aegis_per_chain_liveness_defers_to_global_scrape_liveness" {
  command = plan

  variables {
    grafana_service_account_token     = "fixture"
    slack_bot_token                   = "fixture"
    oncall_support_usergroup_id       = "S012345678"
    splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
  }

  assert {
    condition = (
      length([
        for rule in grafana_rule_group.aegis_service_alerts.rule : rule
        if startswith(rule.name, "Aegis No Successful Poll")
      ]) == length(local.prod_chains) &&
      alltrue([
        for rule in grafana_rule_group.aegis_service_alerts.rule :
        rule.no_data_state == "OK" &&
        strcontains(jsondecode(rule.data[0].model).expr, "or on() vector(0)") &&
        strcontains(jsondecode(rule.data[0].model).expr, "and on() (time() - max(max_over_time(lastUpdatedAt[12m])) < 720)") &&
        tonumber(regex("< ([0-9]+)", jsondecode(rule.data[0].model).expr)[0]) > 300 + 300 + 60
        if startswith(rule.name, "Aegis No Successful Poll")
      ])
    )
    error_message = "Production per-chain Aegis liveness must overlap the global firing tick by one evaluation interval and keep no-data non-alerting."
  }

  assert {
    condition = (
      length([
        for rule in grafana_rule_group.aegis_testnet_health.rule : rule
        if startswith(rule.name, "Aegis Testnet No Successful Poll")
      ]) == length(local.staging_chains) &&
      alltrue([
        for rule in grafana_rule_group.aegis_testnet_health.rule :
        rule.no_data_state == "OK" &&
        strcontains(jsondecode(rule.data[0].model).expr, "or on() vector(0)") &&
        strcontains(jsondecode(rule.data[0].model).expr, "and on() (time() - max(max_over_time(lastUpdatedAt[12m])) < 720)") &&
        tonumber(regex("< ([0-9]+)", jsondecode(rule.data[0].model).expr)[0]) > 300 + 300 + 60
        if startswith(rule.name, "Aegis Testnet No Successful Poll")
      ])
    )
    error_message = "Testnet per-chain Aegis liveness must overlap the global firing tick by one evaluation interval and keep no-data non-alerting."
  }

  assert {
    condition = one([
      for rule in grafana_rule_group.aegis_service_alerts.rule :
      rule.no_data_state == "Alerting" && rule.for == "5m" && jsondecode(rule.data[0].model).expr == "time() - lastUpdatedAt"
      if rule.name == "Aegis does not report new data"
    ])
    error_message = "The global Aegis liveness rule must continue to alert when the heartbeat series disappears."
  }
}
