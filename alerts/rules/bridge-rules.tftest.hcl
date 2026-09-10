mock_provider "grafana" {}

run "bridge_rules_preserve_observation_and_routing_contract" {
  command = plan
  variables {
    grafana_service_account_token     = "mock"
    slack_bot_token                   = "mock"
    oncall_support_usergroup_id       = "S012345678"
    splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
  }
  assert {
    condition     = length(local.bridge_rule_definitions) == 8 && length(grafana_rule_group.bridge_transfers.rule) == 8
    error_message = "Each of the four shared statuses needs separate warning and page rules."
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.bridge_transfers.rule : rule.for == "2m" && rule.no_data_state == "KeepLast" && rule.exec_err_state == "KeepLast"])
    error_message = "A failed complete observation must hold prior transfer alert state."
  }
  assert {
    condition     = grafana_rule_group.bridge_transfers.interval_seconds == 60 && grafana_rule_group.bridge_observation.interval_seconds == 60
    error_message = "Bridge rules evaluate every minute."
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.bridge_observation.rule : rule.no_data_state == "Alerting" && rule.exec_err_state == "Alerting" && rule.for == "2m"])
    error_message = "Observation NoData/Error must raise an infrastructure signal."
  }
  assert {
    condition     = alltrue([for rule in values(local.bridge_rule_definitions) : strcontains(rule.age_expr, local.bridge_transfer_fresh_promql) && strcontains(rule.stuck_expr, local.bridge_transfer_fresh_promql) && strcontains(rule.eligible_expr, local.bridge_transfer_fresh_promql)])
    error_message = "All transfer and annotation queries must lose data together on stale observations."
  }
  assert {
    condition     = alltrue([for rule in values(local.bridge_rule_definitions) : rule.severity == "page" ? rule.eligible_expr == "(${rule.stuck_expr} >= bool 3) + (${rule.age_expr} >= bool ${2 * rule.threshold})" : rule.eligible_expr == "(${rule.age_expr} > bool ${rule.threshold}) * (${rule.stuck_expr} < bool 3) * (${rule.age_expr} < bool ${2 * rule.threshold})"])
    error_message = "Healthy rows cannot count toward paging; warning and page predicates must be exclusive."
  }
  assert {
    condition     = local.bridge_thresholds == jsondecode(file("${path.module}/../../shared-config/bridge-thresholds.json")) && local.bridge_scrape_allowance_seconds == 30
    error_message = "Rules must use the shared threshold file and checked scrape allowance."
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.bridge_transfers.rule : toset(rule.notification_settings[0].group_by) == toset(concat(["alertname"], local.bridge_group_labels)) && rule.notification_settings[0].repeat_interval == "4h" && rule.notification_settings[0].group_interval == "5m" && rule.notification_settings[0].group_wait == "30s"])
    error_message = "Transfer notifications must retain explicit per-route/token/status grouping and repeats."
  }
  assert {
    condition     = one(grafana_contact_point.bridge_warning.slack).recipient == "#alerts-bridges" && one(grafana_contact_point.bridge_page.slack).recipient == "#alerts-critical" && length(grafana_contact_point.bridge_page.victorops) == 1 && one(grafana_contact_point.bridge_infra.slack).recipient == "#alerts-infra"
    error_message = "Use the approved bridge warning, paging and infrastructure destinations."
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.bridge_transfers.rule : length(rule.data) == 4 && strcontains(rule.annotations.description, "Stuck transfers:") && strcontains(rule.annotations.description, "Status threshold:") && strcontains(rule.annotations.dashboard_url, "&destination=")])
    error_message = "Notifications need bounded route links and evaluable age/count/threshold context."
  }
}
