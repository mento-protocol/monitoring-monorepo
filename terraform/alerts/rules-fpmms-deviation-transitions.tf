# ── Deviation breach state transitions ───────────────────────────────────────
resource "grafana_rule_group" "fpmms_deviation_transitions" {
  name             = "Deviation Breach Transitions"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  rule {
    name           = "Deviation Breach State Changed"
    condition      = "threshold"
    for            = "0s"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary          = local.deviation_transition_summary_annotation
      current_reserves = local.deviation_current_reserves_annotation
      breach_duration  = local.deviation_transition_breach_duration_annotation
      breach_started   = local.deviation_transition_breach_started_annotation
      breach_ended     = local.deviation_transition_breach_ended_annotation
    }

    labels = {
      service  = "fpmms"
      severity = "warning"
    }

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = "max without(from, to, reason, breach_started_at, breach_ended_at, breach_duration) (mento_pool_deviation_alert_transition_active{from=~\"warning|deviation_ratio_unavailable_warning\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0)"
        instant = true
      })
    }

    data {
      ref_id         = "Info"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Info"
        expr    = "mento_pool_deviation_alert_transition_active{from=~\"warning|deviation_ratio_unavailable_warning\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0"
        instant = true
      })
    }

    dynamic "data" {
      for_each = local.deviation_reserve_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
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
      contact_point   = local.notify_warning_pools_transition.contact_point
      group_by        = local.notify_warning_pools_transition.group_by
      group_wait      = local.notify_warning_pools_transition.group_wait
      group_interval  = local.notify_warning_pools_transition.group_interval
      repeat_interval = local.notify_warning_pools_transition.repeat_interval
    }
  }

  rule {
    name           = "Deviation Breach Critical State Changed"
    condition      = "threshold"
    for            = "0s"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary          = local.deviation_transition_summary_annotation
      current_reserves = local.deviation_current_reserves_annotation
      breach_duration  = local.deviation_transition_breach_duration_annotation
      breach_started   = local.deviation_transition_breach_started_annotation
      breach_ended     = local.deviation_transition_breach_ended_annotation
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = "max without(from, to, reason, breach_started_at, breach_ended_at, breach_duration) (mento_pool_deviation_alert_transition_active{from=~\"critical|deviation_ratio_unavailable_critical\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0)"
        instant = true
      })
    }

    data {
      ref_id         = "Info"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Info"
        expr    = "mento_pool_deviation_alert_transition_active{from=~\"critical|deviation_ratio_unavailable_critical\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0"
        instant = true
      })
    }

    dynamic "data" {
      for_each = local.deviation_reserve_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
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
      contact_point   = local.notify_critical_transition.contact_point
      group_by        = local.notify_critical_transition.group_by
      group_wait      = local.notify_critical_transition.group_wait
      group_interval  = local.notify_critical_transition.group_interval
      repeat_interval = local.notify_critical_transition.repeat_interval
    }
  }
}
