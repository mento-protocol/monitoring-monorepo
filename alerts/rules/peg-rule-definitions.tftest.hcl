mock_provider "grafana" {}

run "peg_rule_definitions_preserve_consumer_guard_invariant" {
  command = plan

  variables {
    grafana_service_account_token     = "test-grafana-token"
    slack_bot_token                   = "xoxb-test-token"
    oncall_support_usergroup_id       = "S012345678"
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

  assert {
    condition = alltrue([
      for rule in values(local.peg_rule_definitions) :
      trimspace(rule.summary) != "" && trimspace(rule.resolved_summary) != ""
    ])
    error_message = "Every Peg rule must provide cause-first firing and resolved copy."
  }

  assert {
    condition = (
      strcontains(local.peg_rule_definitions["active-downside-europ-schuman/bitvavo_eur"].summary, "Bitvavo sell price is") &&
      strcontains(local.peg_rule_definitions["active-downside-europ-schuman/bitvavo_eur"].summary, "below peg") &&
      strcontains(local.peg_rule_definitions["active-premium-europ-schuman/bitvavo_eur"].summary, "above peg") &&
      strcontains(local.peg_rule_definitions["active-spread-europ-schuman/bitvavo_eur"].summary, "Bitvavo buy and sell prices are") &&
      strcontains(local.peg_rule_definitions["active-structural-europ-schuman"].summary, "EUROP pool flow") &&
      local.peg_rule_definitions["active-registry-rot-europ-schuman/kraken_usd"].summary == "Kraken does not list the EUROP/USD market"
    )
    error_message = "Peg market and listing rules must use the approved cause-first wording."
  }

  assert {
    condition = (
      local.peg_asset_symbol_display_names["kesm"] == "KESm" &&
      local.peg_provider_display_names["valr"] == "VALR"
    )
    error_message = "Peg copy must preserve canonical asset and provider casing."
  }

  assert {
    condition = (
      strcontains(local.peg_rule_definitions["active-unhealthy-europ-schuman/bitvavo_eur"].summary, "rate limit is reached") &&
      strcontains(local.peg_rule_definitions["active-unhealthy-europ-schuman/bitvavo_eur"].summary, "price request returns") &&
      strcontains(local.peg_rule_definitions["active-unhealthy-europ-schuman/bitvavo_eur"].summary, "price request is timing out") &&
      strcontains(local.peg_rule_definitions["active-unhealthy-europ-schuman/bitvavo_eur"].summary, "cannot be reached")
    )
    error_message = "Peg source alerts must expose bounded provider failure reasons."
  }

  assert {
    condition = (
      strcontains(grafana_message_template.peg_slack_title["peg-monitoring"].template, "$alert.Annotations.summary") &&
      strcontains(grafana_message_template.peg_slack_title["peg-monitoring"].template, "$alert.Annotations.resolved_summary") &&
      !strcontains(grafana_message_template.peg_slack_title["peg-monitoring"].template, ".CommonLabels.alertname") &&
      !strcontains(grafana_message_template.peg_slack_message["peg-monitoring"].template, "FIRING:") &&
      !strcontains(grafana_message_template.peg_slack_message["peg-monitoring"].template, "*Policy:*")
    )
    error_message = "Peg Slack copy must lead with the cause and leave state to the title icon."
  }

  assert {
    condition = alltrue(concat(
      [
        for key, item in local.peg_active_sources :
        item.source.authority != "display" || (
          try(local.peg_rule_definitions["active-unhealthy-${key}"].for_duration, "absent") == "absent" &&
          try(local.peg_rule_definitions["active-dead-${key}"].for_duration, "absent") == "absent"
        )
      ],
      [
        for key, item in local.peg_previous_sources :
        item.source.authority != "display" || (
          try(local.peg_rule_definitions["previous-unhealthy-${key}"].for_duration, "absent") == "absent" &&
          try(local.peg_rule_definitions["previous-dead-${key}"].for_duration, "absent") == "absent"
        )
      ],
    ))
    error_message = "Display-authority sources must not create Source Unhealthy or Permanently Dead operational rules."
  }

  assert {
    condition = alltrue(concat(
      [
        for key, item in local.peg_active_sources :
        item.source.authority != "secondary" || try(local.peg_rule_definitions["active-unhealthy-${key}"].for_duration, "absent") == "1800s"
      ],
      [
        for key, item in local.peg_previous_sources :
        item.source.authority != "secondary" || try(local.peg_rule_definitions["previous-unhealthy-${key}"].for_duration, "absent") == "1800s"
      ],
    ))
    error_message = "Secondary-source unhealthy rules must require a sustained 30 minutes."
  }

  assert {
    condition = alltrue(concat(
      [
        for key, item in local.peg_active_sources :
        item.source.authority != "deep" || try(local.peg_rule_definitions["active-unhealthy-${key}"].for_duration, "absent") == "${item.source.pollIntervalSeconds * 2}s"
      ],
      [
        for key, item in local.peg_previous_sources :
        item.source.authority != "deep" || try(local.peg_rule_definitions["previous-unhealthy-${key}"].for_duration, "absent") == "${item.source.pollIntervalSeconds * 2}s"
      ],
    ))
    error_message = "Deep-source unhealthy rules must retain their two-poll hold."
  }
}
