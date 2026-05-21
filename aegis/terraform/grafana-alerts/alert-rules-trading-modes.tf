resource "grafana_rule_group" "trading_modes" {
  name             = "Trading Mode Alerts"
  folder_uid       = var.trading_modes_folder.uid
  interval_seconds = 120

  dynamic "rule" {
    for_each = local.chains

    content {
      name           = "Trading Mode Alert [${rule.value.title}]"
      condition      = "isTradingHalted"
      for            = "5m"
      exec_err_state = "Error"
      no_data_state  = "NoData"

      annotations = {
        summary = "Trading is halted for the {{ $labels.rateFeed }} rate feed on {{ $labels.chain | title }}. Check if a breaker tripped."
      }

      labels = {
        service = "exchanges"
        # Prod trading-mode engagement halts trading on a pair — pager-grade.
        # Staging circuit-breakers fire often during testing and aren't
        # operational fires; keep them as warning so they route to #alerts-testnet.
        severity = rule.value.env == "prod" ? "page" : "warning"
      }

      data {
        ref_id         = "tradingMode"
        datasource_uid = "grafanacloud-prom"

        relative_time_range {
          from = 600
          to   = 0
        }

        model = jsonencode({
          refId   = "tradingMode"
          expr    = "BreakerBox_getRateFeedTradingMode{chain=\"${rule.key}\"}"
          instant = true
        })
      }
      data {
        ref_id         = "isTradingHalted"
        datasource_uid = "__expr__"

        relative_time_range {
          from = 0
          to   = 0
        }

        model = jsonencode({
          refId = "isTradingHalted"
          conditions = [
            {
              type = "query"
              evaluator = {
                params = [0]
                type   = "gt"
              }
              operator = {
                type = "and"
              }
              query = {
                params = ["isTradingHalted"]
              }
            }
          ]
          datasource = {
            type = "__expr__"
            uid  = "__expr__"
          }
          expression = "tradingMode"
          type       = "threshold"
        })
      }
    }
  }
}
