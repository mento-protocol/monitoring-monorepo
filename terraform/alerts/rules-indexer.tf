# Alert rules for the Envio hosted indexer itself. These use Envio-exported
# Prometheus metrics, not metrics-bridge gauges.

resource "grafana_rule_group" "indexer_effect_cache" {
  name             = "Effect Cache"
  folder_uid       = grafana_folder.indexer.uid
  interval_seconds = 60

  rule {
    name           = "Envio Effect Cache Invalidations"
    condition      = "threshold"
    for            = "0m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "{{ if $labels.effect }}Envio effect cache invalidated for {{ $labels.effect }}.{{ else }}Envio effect cache invalidated.{{ end }}"
      description = "Invalidations usually mean effect output/schema drift or a cache-poisoning regression. Check the Envio deployment's Effects cache table before promoting a cache-warm deployment."
    }

    labels = {
      service  = "indexer"
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
        expr    = "sum by (effect) (increase(envio_effect_cache_invalidations_count[5m]))"
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
      contact_point   = local.notify_warning.contact_point
      group_by        = local.notify_warning.group_by
      group_wait      = local.notify_warning.group_wait
      group_interval  = local.notify_warning.group_interval
      repeat_interval = local.notify_warning.repeat_interval
    }
  }
}
