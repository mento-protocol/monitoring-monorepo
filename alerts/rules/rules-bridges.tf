resource "grafana_folder" "bridges" {
  title = "Bridges"
}

resource "grafana_rule_group" "bridge_transfers" {
  name             = "Bridge transfers"
  folder_uid       = grafana_folder.bridges.uid
  interval_seconds = 60

  dynamic "rule" {
    for_each = local.bridge_rule_definitions
    content {
      name      = "Bridge ${rule.value.status} ${rule.value.severity}"
      condition = "threshold"
      for       = "2m"
      # Every query uses the same whole-domain gate. Failure returns no data
      # for the whole rule, not missing individual series that Grafana evicts.
      no_data_state  = "KeepLast"
      exec_err_state = "KeepLast"
      labels         = { service = "bridges", severity = rule.value.severity }
      annotations = {
        summary       = "{{ $labels.token }} bridge transfers are stuck on {{ $labels.source_chain }} → {{ $labels.destination_chain }} ({{ $labels.status }})"
        description   = "Oldest state age: {{ printf \"%.0f\" $values.Age.Value }}s. Stuck transfers: {{ printf \"%.0f\" $values.Stuck.Value }}. Status threshold: ${rule.value.threshold}s. Page at three stuck transfers or ${2 * rule.value.threshold}s. Evaluation runs each minute with a two-minute pending period."
        dashboard_url = local.bridge_dashboard_url
      }
      dynamic "data" {
        for_each = { Age = rule.value.age_expr, Stuck = rule.value.stuck_expr, Eligible = rule.value.eligible_expr }
        content {
          ref_id         = data.key
          datasource_uid = var.prometheus_datasource_uid
          relative_time_range {
            from = 60
            to   = 0
          }
          model = jsonencode({ refId = data.key, expr = data.value, instant = true })
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
          refId      = "threshold", type = "threshold", expression = "Eligible",
          conditions = [{ evaluator = { params = [0], type = "gt" }, operator = { type = "and" }, query = { params = ["threshold"] } }],
          datasource = { type = "__expr__", uid = "__expr__" }
        })
      }
      notification_settings {
        contact_point   = rule.value.severity == "page" ? grafana_contact_point.bridge_page.name : grafana_contact_point.bridge_warning.name
        group_by        = concat(["alertname"], local.bridge_group_labels)
        group_wait      = "30s"
        group_interval  = "5m"
        repeat_interval = "4h"
      }
    }
  }
}

resource "grafana_rule_group" "bridge_observation" {
  name             = "Bridge observation health"
  folder_uid       = grafana_folder.bridges.uid
  interval_seconds = 60
  dynamic "rule" {
    for_each = {
      unavailable = { name = "Bridge observation unavailable", expr = local.bridge_unavailable_promql, description = "Bridge observations failed, never succeeded, became stale, or stopped exporting. Transfer alerts retain their previous state until a complete fresh observation succeeds." }
      invalid     = { name = "Bridge observation contains unknown data", expr = local.bridge_invalid_promql, description = "Bridge rows have unknown route, token, status or time. Inspect the broader bridge dashboard; unknown values cannot establish a healthy transfer queue." }
    }
    content {
      name           = rule.value.name
      condition      = "threshold"
      for            = "2m"
      no_data_state  = "Alerting"
      exec_err_state = "Alerting"
      labels         = { service = "bridges", severity = "warning" }
      annotations    = { summary = rule.value.name, description = rule.value.description, dashboard_url = "https://monitoring.mento.org/bridge-flows" }
      data {
        ref_id         = "A"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = 60
          to   = 0
        }
        model = jsonencode({ refId = "A", expr = rule.value.expr, instant = true })
      }
      data {
        ref_id         = "threshold"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({ refId = "threshold", type = "threshold", expression = "A", conditions = [{ evaluator = { params = [0], type = "gt" }, operator = { type = "and" }, query = { params = ["threshold"] } }], datasource = { type = "__expr__", uid = "__expr__" } })
      }
      notification_settings {
        contact_point   = grafana_contact_point.bridge_infra.name
        group_by        = ["alertname"]
        group_wait      = "30s"
        group_interval  = "5m"
        repeat_interval = "4h"
      }
    }
  }
}
