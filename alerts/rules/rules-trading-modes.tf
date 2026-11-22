resource "grafana_rule_group" "trading_modes" {
  name             = "Trading Mode Alerts"
  folder_uid       = grafana_folder.trading_modes.uid
  interval_seconds = 120

  dynamic "rule" {
    for_each = local.chains

    content {
      name      = "Trading Mode Alert [${rule.value.title}]"
      condition = "isTradingHalted"
      for       = "5m"
      # USDT/USD can hover around the breaker threshold and briefly repeg before
      # tripping again. Keep the incident open across short healthy dips so
      # Splunk On-Call does not create a fresh SMS page for every flap.
      keep_firing_for = "1h"
      exec_err_state  = "Error"
      no_data_state   = "NoData"

      annotations = {
        summary = "Trading is halted for the {{ $labels.rateFeed }} rate feed on {{ $labels.chain | title }}. Check if a breaker tripped."
      }

      labels = {
        service = "exchanges"
        # Prod trading-mode engagement halts trading on a pair. This rule feeds
        # the real-time halted/resumed posts in #alerts-critical; Splunk
        # On-Call is paged by the "Trading Mode Page" rule below instead.
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

  # Pager copy of the rule above, prod chains only. A breaker halt usually needs
  # no action: the market has to catch up before trading resumes. USDT/USD in
  # particular halts, resumes for a few hours and halts again (Splunk incidents
  # #1715, #1716 and #1717 for USDT/USD [Monad] on 2026-10-28), and every new
  # halt after the 1h `keep_firing_for` above opened a fresh SMS page.
  #
  # `keep_firing_for = "24h"` keeps this alert open for a day after the last
  # halted sample, so re-trips inside that day join the open Splunk incident
  # instead of paging again. Together with the 1d `repeat_interval` on the
  # Splunk route, a feed pages once when it first halts and then at most once
  # a day. A halt on another feed still pages immediately (the route groups by
  # rateFeed). The Splunk incident resolves 24h after the last halt; the
  # real-time "Trading resumed" post comes from the rule above in Slack.
  dynamic "rule" {
    for_each = local.prod_chains

    content {
      name            = "Trading Mode Page [${rule.value.title}]"
      condition       = "isTradingHalted"
      for             = "5m"
      keep_firing_for = "24h"
      exec_err_state  = "Error"
      no_data_state   = "NoData"

      annotations = {
        summary          = "Trading is halted for the {{ $labels.rateFeed }} rate feed on {{ $labels.chain | title }}. Check if a breaker tripped."
        resolved_summary = "No breaker halt on this feed for 24 hours. The next halt pages again."
      }

      labels = {
        service  = "exchanges"
        severity = "page"
        # Selects the Splunk On-Call route and keeps this copy out of Slack.
        route = "pager"
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
