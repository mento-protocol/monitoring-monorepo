mock_provider "grafana" {}

run "relayer_balance_alerts_follow_the_runway_policy" {
  command = plan

  variables {
    grafana_service_account_token     = "fixture"
    slack_bot_token                   = "fixture"
    oncall_support_usergroup_id       = "S012345678"
    splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
  }

  assert {
    condition = alltrue([
      for k, r in local.refiller_balance_rules :
      length([for rule in grafana_rule_group.oracle_relayers.rule : rule if rule.name == r.name]) == 1
    ]) && length(local.refiller_balance_rules) == length(local.chains)
    error_message = "Every chain needs exactly one refiller low-balance rule."
  }

  assert {
    condition     = sort(keys(local.relayer_burn)) == sort(keys(local.chains))
    error_message = "Every chain in the registry needs a relayer_burn entry, and no stale ones may remain."
  }

  assert {
    condition = (
      local.refiller_balance_rules["celo"].threshold == ceil(7200 * 14 / 30) &&
      local.refiller_balance_rules["polygon"].threshold == ceil(7000 * 14 / 30) &&
      local.refiller_balance_rules["monad"].threshold == ceil(2100 * 14 / 30) &&
      # On testnets the floor (one round of top-ups) wins over the tiny burn.
      local.refiller_balance_rules["celo-sepolia"].threshold == 70
    )
    error_message = "The refiller alert must fire below 14 days of the chain's relay burn, or the testnet floor."
  }

  assert {
    condition = alltrue([
      for rule in grafana_rule_group.oracle_relayers.rule :
      strcontains(jsondecode(rule.data[0].model).expr, "owner=\"RelayerRefiller\"") &&
      !strcontains(jsondecode(rule.data[0].model).expr, "RelayerSigner")
      if startswith(rule.name, "Low Refiller Balance")
    ])
    error_message = "Refiller rules must select only the RelayerRefiller owner, never the signers."
  }

  assert {
    condition = (
      local.signer_balance_rules["celo/default"].threshold == 75 &&
      local.signer_balance_rules["celo/composite"].threshold == 130 &&
      local.signer_balance_rules["celo/gas"].threshold == 1 &&
      local.signer_balance_rules["monad/default"].threshold == 110 &&
      local.signer_balance_rules["monad/hourly"].threshold == 7.5 &&
      local.signer_balance_rules["polygon/default"].threshold == 675 &&
      local.signer_balance_rules["celo-sepolia/default"].threshold == 0.05
    )
    error_message = "Signer thresholds must be ~5 days of each class's relay burn."
  }

  assert {
    condition = alltrue([
      for k, c in local.relayer_burn : alltrue([
        for class_key, cls in c.signer_classes : alltrue([
          for feed in cls.feeds :
          strcontains(local.signer_balance_rules["${k}/default"].exclude, feed)
        ])
      ])
    ])
    error_message = "The default signer rule must exclude every feed a signer class covers, or that signer would alert twice with two thresholds."
  }

  assert {
    condition = alltrue([
      for rule in grafana_rule_group.oracle_relayers.rule :
      rule.annotations.runwayDays == tostring(local.signer_balance_rules[
        one([for k, r in local.signer_balance_rules : k if r.name == rule.name])
      ].runway_days)
      if startswith(rule.name, "Low ") && !startswith(rule.name, "Low Refiller Balance")
    ]) && local.signer_balance_rules["celo/gas"].runway_days == 20
    error_message = "Signer alert copy reads the runway from the rule, so each rule must publish its own class's runway days."
  }

  assert {
    condition = alltrue(flatten([
      for k, c in local.relayer_burn : [
        for class_key, cls in c.signer_classes : [
          for feed in cls.feeds :
          strcontains(file("${path.module}/../../aegis/config.yaml"), "RelayerSigner${feed}: ")
        ]
      ]
    ])) && strcontains(file("${path.module}/../../aegis/config.yaml"), "RelayerRefiller: ")
    error_message = "Every owner these rules select must be published by Aegis (a global var in aegis/config.yaml), or the rule can never fire."
  }

  assert {
    condition = alltrue([
      for rule in grafana_rule_group.oracle_relayers.rule : rule.no_data_state == "NoData"
      if startswith(rule.name, "Low Refiller Balance")
    ])
    error_message = "Refiller rules must alert on NoData: a missing RelayerRefiller series would otherwise leave the wallet unwatched without anyone noticing."
  }

  assert {
    condition = alltrue([
      for rule in grafana_rule_group.oracle_relayers.rule :
      contains(local.alert_types.oracle_relayer_low_balance.names, rule.name) ||
      contains(local.alert_types.relayer_refiller_low_balance.names, rule.name)
      if startswith(rule.name, "Low ")
    ])
    error_message = "Every low-balance rule name needs a dispatcher branch, or its Slack message falls back to raw labels."
  }
}
