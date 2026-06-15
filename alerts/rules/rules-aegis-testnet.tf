# Aegis testnet health alerts.
#
# These intentionally use Aegis self-metrics only. Testnet does not have a
# metrics-bridge/exported Envio pool gauge path, but Aegis already polls
# Celo Sepolia + Monad Testnet oracle freshness, breaker modes, and relayer
# balances. Alerting on successful/error polling keeps testnet health visible
# without standing up per-chain testnet indexers or bridge exporters.

resource "grafana_rule_group" "aegis_testnet_health" {
  name             = "Aegis testnet health"
  folder_uid       = data.grafana_folder.aegis.uid
  interval_seconds = 60

  dynamic "rule" {
    for_each = local.staging_chains
    iterator = chain

    content {
      name           = "Aegis Testnet No Successful Poll [${chain.value.title}]"
      condition      = "threshold"
      for            = "5m"
      exec_err_state = "Error"
      no_data_state  = "Alerting"

      data {
        ref_id = "successfulPolls"

        relative_time_range {
          from = 600
          to   = 0
        }

        datasource_uid = var.prometheus_datasource_uid
        model = jsonencode({
          refId         = "successfulPolls"
          expr          = "sum(increase(view_call_query_duration_count{chain=\"${chain.value.aegis_chain}\",status=\"success\"}[10m]))"
          editorMode    = "code"
          instant       = true
          intervalMs    = 1000
          legendFormat  = "__auto"
          maxDataPoints = 43200
          range         = false
        })
      }

      data {
        ref_id = "threshold"

        relative_time_range {
          from = 600
          to   = 0
        }

        datasource_uid = "__expr__"
        model = jsonencode({
          refId         = "threshold"
          type          = "threshold"
          expression    = "successfulPolls"
          intervalMs    = 1000
          maxDataPoints = 43200
          conditions = [{
            evaluator = { params = [1], type = "lt" }
            operator  = { type = "and" }
            query     = { params = ["threshold"] }
            reducer   = { params = [], type = "last" }
            type      = "query"
          }]
          datasource = { type = "__expr__", uid = "__expr__" }
        })
      }

      annotations = {
        summary = "Aegis has not completed a successful ${chain.value.title} testnet view-call batch in 10 minutes."
      }

      labels = {
        service  = "aegis-testnet"
        severity = "warning"
        chain    = chain.key
      }

      notification_settings {
        contact_point   = local.notify_warning_testnet.contact_point
        group_by        = local.notify_warning_testnet.group_by
        group_wait      = local.notify_warning_testnet.group_wait
        group_interval  = local.notify_warning_testnet.group_interval
        repeat_interval = local.notify_warning_testnet.repeat_interval
      }
    }
  }

  dynamic "rule" {
    for_each = local.staging_chains
    iterator = chain

    content {
      name           = "Aegis Testnet Poll Errors [${chain.value.title}]"
      condition      = "threshold"
      for            = "10m"
      exec_err_state = "Error"
      no_data_state  = "OK"

      data {
        ref_id = "errorPolls"

        relative_time_range {
          from = 600
          to   = 0
        }

        datasource_uid = var.prometheus_datasource_uid
        model = jsonencode({
          refId         = "errorPolls"
          expr          = "sum(increase(view_call_query_duration_count{chain=\"${chain.value.aegis_chain}\",status=\"error\"}[10m]))"
          editorMode    = "code"
          instant       = true
          intervalMs    = 1000
          legendFormat  = "__auto"
          maxDataPoints = 43200
          range         = false
        })
      }

      data {
        ref_id = "threshold"

        relative_time_range {
          from = 600
          to   = 0
        }

        datasource_uid = "__expr__"
        model = jsonencode({
          refId         = "threshold"
          type          = "threshold"
          expression    = "errorPolls"
          intervalMs    = 1000
          maxDataPoints = 43200
          conditions = [{
            evaluator = { params = [0], type = "gt" }
            operator  = { type = "and" }
            query     = { params = ["threshold"] }
            reducer   = { params = [], type = "last" }
            type      = "query"
          }]
          datasource = { type = "__expr__", uid = "__expr__" }
        })
      }

      annotations = {
        summary = "Aegis is recording failed ${chain.value.title} testnet view-call batches."
      }

      labels = {
        service  = "aegis-testnet"
        severity = "warning"
        chain    = chain.key
      }

      notification_settings {
        contact_point   = local.notify_warning_testnet.contact_point
        group_by        = local.notify_warning_testnet.group_by
        group_wait      = local.notify_warning_testnet.group_wait
        group_interval  = local.notify_warning_testnet.group_interval
        repeat_interval = local.notify_warning_testnet.repeat_interval
      }
    }
  }
}
