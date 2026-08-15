resource "grafana_rule_group" "peg_monitoring" {
  for_each = local.peg_alert_instances

  name             = "Peg Monitoring"
  folder_uid       = grafana_folder.peg_monitoring[each.key].uid
  interval_seconds = 60

  depends_on = [
    grafana_contact_point.peg_market_warning,
    grafana_contact_point.peg_ops_warning,
    grafana_contact_point.peg_page,
  ]

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
        resolved_summary = rule.value.resolved_summary
        action           = rule.value.action
        asset_name       = rule.value.asset == "policy" ? "Peg monitor" : local.peg_asset_display_names[rule.value.asset]
        source_name      = rule.value.source == "" ? "" : local.peg_source_display_names["${rule.value.asset}/${rule.value.source}"]
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
        fill = "{{ if and $values.Fill (ge $values.Fill.Value 0.0) }}{{ printf \"%.1f%%\" $values.Fill.Value }}{{ else }}unavailable{{ end }}"
        listing_state = (
          startswith(rule.value.name, "Peg Registry Rot") || startswith(rule.value.name, "Peg Critical Path Unreachable")
          ? "absent"
          : ""
        )
        listing_check_age = (
          startswith(rule.value.name, "Peg Registry Rot") || startswith(rule.value.name, "Peg Critical Path Unreachable")
          ? "{{ if and $values.ListingAge (ge $values.ListingAge.Value 0.0) }}{{ printf \"%.0fs ago\" $values.ListingAge.Value }}{{ else }}unavailable{{ end }}"
          : ""
        )
        structural_saturation = "{{ if and $values.Structural (ge $values.Structural.Value 0.0) }}{{ printf \"%.1f%%\" $values.Structural.Value }}{{ else }}unavailable{{ end }}"
        corroboration = startswith(rule.value.name, "Peg Blind While Stressed Critical") ? "separate market data also shows stress" : (
          startswith(rule.value.name, "Peg Deep-Venue Downside Critical")
          ? "{{ if and $values.Corroboration (gt $values.Corroboration.Value 0.0) }}separate pool or venue data also shows stress{{ else }}no extra confirmation required{{ end }}"
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
        ref_id         = "ListingAge"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId   = "ListingAge"
          expr    = try(coalesce(rule.value.listing_age_expr, local.peg_empty_context_promql), local.peg_empty_context_promql)
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
          expr    = try(coalesce(rule.value.spread_expr, local.peg_empty_context_promql), local.peg_empty_context_promql)
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

      # These helper values are stored with each Grafana state transition.
      # They do not participate in the alert condition or instance labels.
      data {
        ref_id         = "Reason"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId = "Reason"
          expr = rule.value.source != "" ? format(
            "max(mento_peg_source_failure_reason{asset=\"%s\",source=\"%s\",policy_version=\"%s\"}) or on() vector(0)",
            rule.value.asset,
            rule.value.source,
            rule.value.policy_version,
            ) : rule.value.asset != "policy" ? format(
            "max(mento_peg_structural_failure_reason{asset=\"%s\",policy_version=\"%s\"}) or on() vector(0)",
            rule.value.asset,
            rule.value.policy_version,
          ) : local.peg_no_corroboration_promql
          instant = true
        })
      }

      data {
        ref_id         = "HttpStatus"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = max(rule.value.query_range, 60)
          to   = 0
        }
        model = jsonencode({
          refId = "HttpStatus"
          expr = rule.value.source != "" ? format(
            "max(mento_peg_source_failure_http_status{asset=\"%s\",source=\"%s\",policy_version=\"%s\"}) or on() vector(0)",
            rule.value.asset,
            rule.value.source,
            rule.value.policy_version,
          ) : local.peg_no_corroboration_promql
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
