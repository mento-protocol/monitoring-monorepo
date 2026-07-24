resource "grafana_rule_group" "peg_monitoring" {
  name             = "Peg Monitoring"
  folder_uid       = grafana_folder.peg_monitoring.uid
  interval_seconds = 60

  dynamic "rule" {
    for_each = local.peg_rule_definitions
    content {
      name           = rule.value.name
      condition      = "threshold"
      for            = rule.value.for_duration
      exec_err_state = "Error"
      no_data_state  = rule.value.no_data_state

      annotations = {
        summary          = rule.value.summary
        action           = rule.value.action
        executable_price = "{{ if and $values.Price (ge $values.Price.Value 0.0) }}{{ printf \"%.6f\" $values.Price.Value }}{{ else }}unavailable{{ end }}"
        deviation_bps = (
          startswith(rule.value.name, "Peg Downside Warning") || startswith(rule.value.name, "Peg Deep-Venue Downside Critical")
          ? "{{ if $values.A }}{{ printf \"%.1f\" $values.A.Value }}{{ end }}"
          : ""
        )
        premium_bps = startswith(rule.value.name, "Peg Premium Warning") ? "{{ if $values.A }}{{ printf \"%.1f\" $values.A.Value }}{{ end }}" : ""
        spread_bps = startswith(rule.value.name, "Peg Deep-Venue Spread Warning") ? "{{ if $values.A }}{{ printf \"%.1f\" $values.A.Value }}{{ end }}" : (
          startswith(rule.value.name, "Peg Deep-Venue Downside Critical") || startswith(rule.value.name, "Peg Blind While Stressed Critical")
          ? "{{ if and $values.Spread (ge $values.Spread.Value 0.0) }}{{ printf \"%.1f\" $values.Spread.Value }}{{ end }}"
          : ""
        )
        fill                  = "{{ if and $values.Fill (ge $values.Fill.Value 0.0) }}{{ printf \"%.1f%%\" $values.Fill.Value }}{{ else }}unavailable{{ end }}"
        structural_saturation = "{{ if and $values.Structural (ge $values.Structural.Value 0.0) }}{{ printf \"%.1f%%\" $values.Structural.Value }}{{ else }}unavailable{{ end }}"
        corroboration = startswith(rule.value.name, "Peg Blind While Stressed Critical") ? "blindness plus structural saturation, spread, or partial-price shortfall" : (
          startswith(rule.value.name, "Peg Deep-Venue Downside Critical")
          ? "{{ if and $values.Corroboration (gt $values.Corroboration.Value 0.0) }}structural saturation or a distinct fresh uncapped venue{{ else }}none required; deep venue pages alone{{ end }}"
          : ""
        )
      }

      labels = {
        service        = "peg-monitoring"
        severity       = rule.value.severity
        route          = rule.value.route
        asset          = rule.value.asset
        source         = rule.value.source
        policy_version = rule.value.policy_version
      }

      data {
        ref_id         = "A"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId   = "A"
          expr    = rule.value.expr
          instant = true
        })
      }

      data {
        ref_id         = "Price"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId   = "Price"
          expr    = rule.value.price_expr
          instant = true
        })
      }

      data {
        ref_id         = "Fill"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId   = "Fill"
          expr    = rule.value.fill_expr
          instant = true
        })
      }

      data {
        ref_id         = "Structural"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId   = "Structural"
          expr    = rule.value.structural_expr
          instant = true
        })
      }

      data {
        ref_id         = "Spread"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId   = "Spread"
          expr    = try(rule.value.spread_expr, local.peg_empty_context_promql)
          instant = true
        })
      }

      data {
        ref_id         = "Corroboration"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId   = "Corroboration"
          expr    = rule.value.corroboration_expr
          instant = true
        })
      }

      data {
        ref_id         = "threshold"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          refId      = "threshold"
          type       = "threshold"
          expression = "A"
          conditions = [{
            evaluator = { params = [0], type = "gt" }
            operator  = { type = "and" }
            query     = { params = ["threshold"] }
          }]
          datasource = { type = "__expr__", uid = "__expr__" }
        })
      }

      notification_settings {
        contact_point   = rule.value.notification.contact_point
        group_by        = rule.value.notification.group_by
        group_wait      = rule.value.notification.group_wait
        group_interval  = rule.value.notification.group_interval
        repeat_interval = rule.value.notification.repeat_interval
      }
    }
  }
}
