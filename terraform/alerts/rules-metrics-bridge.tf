# Alert rules for the metrics-bridge Cloud Run service itself. If the bridge
# stops reporting, EVERY fpmms metric goes stale — so `no_data_state` here is
# `Alerting` (not `OK` like the fpmms rules). That's the single place where the
# absence of data is the signal, not noise.

resource "grafana_rule_group" "metrics_bridge" {
  name             = "Health"
  folder_uid       = grafana_folder.metrics_bridge.uid
  interval_seconds = 60

  rule {
    name           = "Metrics Bridge Not Reporting"
    condition      = "threshold"
    for            = "2m"
    exec_err_state = "Error"
    no_data_state  = "Alerting"

    annotations = {
      summary     = "metrics-bridge last poll was {{ printf \"%.0f\" $values.A.Value }}s ago — pool metrics stale."
      description = "`time() - mento_pool_bridge_last_poll > 90` (3x the 30s poll interval). Every fpmms alert that depends on fresh pool state is now blind. Check Cloud Run logs: `gcloud run services logs read metrics-bridge --project mento-monitoring`."
    }

    labels = {
      service  = "metrics-bridge"
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
        expr    = "time() - mento_pool_bridge_last_poll"
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
          evaluator = { params = [90], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_critical.contact_point
      group_by        = local.notify_critical.group_by
      group_wait      = local.notify_critical.group_wait
      group_interval  = local.notify_critical.group_interval
      repeat_interval = local.notify_critical.repeat_interval
    }
  }

  rule {
    name           = "Metrics Bridge Poll Errors"
    condition      = "threshold"
    for            = "3m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "metrics-bridge polling the indexer with errors — rate {{ printf \"%.3f\" $values.A.Value }}/s."
      description = "`rate(mento_pool_bridge_poll_errors_total[5m]) > 0` — the bridge is hitting the Envio indexer but failing. Likely an Envio rate limit (429) or a schema drift. Stale gauge values remain, but the alert-on-change signal is degraded."
    }

    labels = {
      service  = "metrics-bridge"
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
        expr    = "rate(mento_pool_bridge_poll_errors_total[5m])"
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
      contact_point   = local.notify_critical.contact_point
      group_by        = local.notify_critical.group_by
      group_wait      = local.notify_critical.group_wait
      group_interval  = local.notify_critical.group_interval
      repeat_interval = local.notify_critical.repeat_interval
    }
  }
}
