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
      if startswith(rule.name, "Low ") || startswith(rule.name, "Refiller ")
    ])
    error_message = "Every low-balance rule name needs a dispatcher branch, or its Slack message falls back to raw labels."
  }
  assert {
    condition = (
      sort(keys(local.refiller_urgent_rules)) == sort(keys(local.prod_chains)) &&
      local.refiller_urgent_rules["celo"].threshold == 1500 &&
      local.refiller_urgent_rules["monad"].threshold == 700 &&
      local.refiller_urgent_rules["polygon"].threshold == 2000 &&
      alltrue([for k, r in local.refiller_urgent_rules : r.threshold < local.refiller_balance_rules[k].threshold])
    )
    error_message = "The urgent level exists for prod chains only, at the largest plausible single run of top-ups, and always below the early warning."
  }

  assert {
    condition = alltrue([
      for rule in grafana_rule_group.oracle_relayers.rule :
      join(",", sort(keys(rule.labels))) == "explorer,service,severity,token"
      if startswith(rule.name, "Low Refiller Balance")
    ])
    error_message = "The early-warning rule's label set is its identity in Grafana. A new label resolves and re-fires whatever is firing at deploy time and posts a false 'funded again' message. Put new labels on the urgent rule only."
  }

  assert {
    condition = alltrue([
      for rule in grafana_rule_group.oracle_relayers.rule :
      rule.labels.urgency == "urgent" && rule.no_data_state == "NoData"
      if startswith(rule.name, "Refiller Cannot Cover Refills")
    ])
    error_message = "Urgent refiller rules must carry urgency=urgent (the templates pick their wording from it) and alert on NoData."
  }

  assert {
    condition = (
      jsonencode([for k, r in local.refiller_rules : r.urgent]) ==
      jsonencode(concat([for k in keys(local.refiller_balance_rules) : false], [for k in keys(local.refiller_urgent_rules) : true]))
    )
    error_message = "Urgent rules must be appended after every early-warning rule. The provider tracks rule UIDs by position, so interleaving them would shift the identity of existing rules."
  }

  assert {
    condition = (
      length([
        for p in grafana_notification_policy.all.policy[0].policy : p
        if p.repeat_interval == "24h" && length([for m in p.matcher : m if m.label == "alertname" && startswith(m.value, "Low Refiller Balance [")]) == 1
      ]) == length(local.chains) &&
      length([
        for p in grafana_notification_policy.all.policy[0].policy : p
        if length([for m in p.matcher : m if m.label == "alertname" && startswith(m.value, "Refiller Cannot Cover")]) > 0
      ]) == 0
    )
    error_message = "Every early-warning refiller alert needs its own daily-repeat route, and the urgent level must not have one: it keeps the tree's 4h repeat."
  }
  assert {
    condition = alltrue([
      for k, r in local.refiller_rules :
      r.top_up_target >= r.monthly_burn &&
      r.top_up_target >= 2 * local.refiller_balance_rules[r.chain_key].threshold
      ]) && (
      local.refiller_balance_rules["polygon"].top_up_target == 7000 &&
      local.refiller_balance_rules["celo-sepolia"].top_up_target == 140
    )
    error_message = "Sending the amount the alert recommends must clear the alert: the top-up target has to be at least a month of burn and at least twice the early-warning threshold, which matters on testnets where the threshold is a floor above the monthly burn."
  }
}
