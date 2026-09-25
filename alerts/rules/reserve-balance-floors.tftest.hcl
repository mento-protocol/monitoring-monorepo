mock_provider "grafana" {}

run "reserve_floors_notify_at_one_level" {
  command = plan

  variables {
    grafana_service_account_token     = "fixture"
    slack_bot_token                   = "fixture"
    oncall_support_usergroup_id       = "S012345678"
    splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
  }

  assert {
    condition = alltrue(flatten([
      for chain, tokens in local.reserve_balance_floors : [
        for token, floor in tokens : floor.critical < floor.warning
      ]
    ]))
    error_message = "Each critical floor must sit below its warning floor."
  }

  assert {
    condition = alltrue(flatten([
      for chain, tokens in local.reserve_balance_floors : [
        for token, floor in tokens : [
          local.reserve_floor_rules["${chain}-${token}-warning"].expression == "$balance >= ${floor.critical} && $balance < ${floor.warning}",
          local.reserve_floor_rules["${chain}-${token}-critical"].expression == "$balance < ${floor.critical}",
        ]
      ]
    ]))
    error_message = "The warning band must start exactly at the critical floor, so the bands neither overlap nor leave a gap."
  }

  assert {
    condition = alltrue([
      for k, r in local.reserve_floor_rules :
      contains(local.alert_types.low_reserve_balance.names, r.name) &&
      length([for rule in grafana_rule_group.reserve_balances.rule : rule if rule.name == r.name]) == 1
    ])
    error_message = "Every floor rule needs exactly one rule in the reserve group and a reserve template dispatcher branch."
  }
}
