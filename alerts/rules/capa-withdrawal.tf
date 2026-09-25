# A receipt-proved, event-scoped notification. metrics-bridge checks both the
# indexed FPMM Burn and LP-token Transfer(owner -> pool -> zero) in its receipt.
# Grafana fingerprints each event_id once; the six-hour metric window is
# shorter than the 24-hour repeat interval and resolved posts are disabled.
resource "grafana_contact_point" "capa_pool_withdrawal" {
  name = "Capa Polygon LP withdrawals (#pool-alerts)"

  slack {
    token                   = var.slack_bot_token
    recipient               = var.slack_channel_capa_pool
    disable_resolve_message = true
    title                   = "🟡 Capa liquidity withdrawal"
    text                    = <<-EOT
      {{ range .Alerts.Firing -}}
      *<https://monitoring.mento.org/pool/137-0x93e15a22fda39fefccce82d387a09ccf030ead61|Capa removed liquidity — EURm/USDm · Polygon>*
      *Pool burn:* {{ .Labels.eurm }} EURm + {{ .Labels.usdm }} USDm. These are gross pool outflows; the transaction may also swap tokens.
      *LP owner:* <https://polygonscan.com/address/{{ .Labels.owner }}|{{ .Labels.owner }}>
      *Evidence:* <https://polygonscan.com/tx/{{ .Labels.tx_hash }}|Polygon transaction> · indexed burn `{{ .Labels.event_id }}`
      {{ end -}}
    EOT
  }
}

resource "grafana_rule_group" "capa_pool_withdrawal" {
  name             = "Capa LP Withdrawal"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  rule {
    name           = "Capa Liquidity Withdrawal [Polygon EURm/USDm]"
    condition      = "threshold"
    for            = "0s"
    exec_err_state = "Error"
    no_data_state  = "OK"

    labels = {
      service  = "fpmms"
      severity = "warning"
      chain    = "polygon"
      chain_id = "137"
      pool_id  = "137-0x93e15a22fda39fefccce82d387a09ccf030ead61"
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
        expr    = "mento_pool_capa_polygon_eurm_usdm_withdrawal_timestamp > time() - 21600"
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
      contact_point   = grafana_contact_point.capa_pool_withdrawal.name
      group_by        = ["event_id"]
      group_wait      = "10s"
      group_interval  = "1m"
      repeat_interval = "24h"
    }
  }
}
