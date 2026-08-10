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
