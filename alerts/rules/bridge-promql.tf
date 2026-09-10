locals {
  bridge_thresholds = jsondecode(file("${path.module}/../../shared-config/bridge-thresholds.json"))
  # Alloy's configured 30s scrape can add this much age to the runtime budget.
  bridge_scrape_allowance_seconds = 30
  bridge_group_labels             = ["source_chain", "destination_chain", "token", "status"]
  bridge_fresh_promql             = "(mento_ntt_bridge_observation_error == 0) and (mento_ntt_bridge_last_success_timestamp_seconds > 0) and ((time() - mento_ntt_bridge_last_success_timestamp_seconds) >= 0) and ((time() - mento_ntt_bridge_last_success_timestamp_seconds) <= (mento_ntt_bridge_freshness_limit_seconds + ${local.bridge_scrape_allowance_seconds}))"
  bridge_transfer_fresh_promql    = "(${local.bridge_fresh_promql}) and (mento_ntt_bridge_invalid_rows == 0) and on() ((${local.bridge_unavailable_promql}) == 0)"
  bridge_age_promql               = "max by (source_chain, destination_chain, token, status) (mento_ntt_bridge_oldest_state_age_seconds and on(job, instance) (${local.bridge_transfer_fresh_promql}))"
  bridge_stuck_promql             = "max by (source_chain, destination_chain, token, status) (mento_ntt_bridge_stuck_transfers and on(job, instance) (${local.bridge_transfer_fresh_promql}))"
  bridge_unavailable_promql       = "(max((mento_ntt_bridge_observation_error != bool 0) + (mento_ntt_bridge_last_success_timestamp_seconds <= bool 0) + ((time() - mento_ntt_bridge_last_success_timestamp_seconds) < bool 0) + ((time() - mento_ntt_bridge_last_success_timestamp_seconds) > bool (mento_ntt_bridge_freshness_limit_seconds + ${local.bridge_scrape_allowance_seconds}))) or vector(0)) + (absent(mento_ntt_bridge_observation_error) or vector(0)) + (absent(mento_ntt_bridge_last_success_timestamp_seconds) or vector(0)) + (absent(mento_ntt_bridge_freshness_limit_seconds) or vector(0)) + (absent(mento_ntt_bridge_transfers) or vector(0)) + (absent(mento_ntt_bridge_stuck_transfers) or vector(0)) + (absent(mento_ntt_bridge_oldest_state_age_seconds) or vector(0)) + (absent(mento_ntt_bridge_invalid_rows) or vector(0))"
  bridge_invalid_promql           = "max(mento_ntt_bridge_invalid_rows and on(job, instance) (${local.bridge_fresh_promql})) or vector(0)"
  bridge_rule_inputs = merge([
    for status, seconds in local.bridge_thresholds : {
      for severity in ["warning", "page"] : "${status}-${severity}" => {
        status     = status
        severity   = severity
        threshold  = seconds
        age_expr   = "max by (source_chain, destination_chain, token, status) (mento_ntt_bridge_oldest_state_age_seconds{status=\"${status}\"} and on(job, instance) (${local.bridge_transfer_fresh_promql}))"
        stuck_expr = "max by (source_chain, destination_chain, token, status) (mento_ntt_bridge_stuck_transfers{status=\"${status}\"} and on(job, instance) (${local.bridge_transfer_fresh_promql}))"
      }
    }
  ]...)
  bridge_rule_definitions = {
    for key, input in local.bridge_rule_inputs : key => merge(input, {
      eligible_expr = input.severity == "page" ? "(${input.stuck_expr} >= bool 3) + (${input.age_expr} >= bool ${2 * input.threshold})" : "(${input.age_expr} > bool ${input.threshold}) * (${input.stuck_expr} < bool 3) * (${input.age_expr} < bool ${2 * input.threshold})"
    })
  }
  bridge_dashboard_url      = "https://monitoring.mento.org/bridge-flows?status={{ $labels.status }}{{ if ne $labels.source_chain \"unknown\" }}&source={{ $labels.source_chain }}{{ end }}{{ if ne $labels.destination_chain \"unknown\" }}&destination={{ $labels.destination_chain }}{{ end }}"
  bridge_notification_title = "{{ .Status | toUpper }}: bridge transfer monitoring"
  bridge_notification_body  = <<-EOT
    {{ range .Alerts }}
    {{ if eq .Status "resolved" }}
    Bridge alert resolved: {{ .Labels.alertname }}
    {{ if .Labels.source_chain }}Route: {{ .Labels.source_chain }} → {{ .Labels.destination_chain }} / {{ .Labels.token }} / {{ .Labels.status }}{{ end }}
    {{ else }}
    {{ .Annotations.summary }}
    {{ .Annotations.description }}
    {{ end }}
    {{ if .Annotations.dashboard_url }}{{ .Annotations.dashboard_url }}{{ end }}
    {{ end }}
  EOT
}
