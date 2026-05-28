resource "grafana_rule_group" "oracle_relayers" {
  name             = "Oracle Relayer Alerts"
  folder_uid       = grafana_folder.oracle_relayers.uid
  interval_seconds = 120

  dynamic "rule" {
    for_each = local.chains

    content {
      name           = "Oldest Report Expired [${rule.value.title}]"
      condition      = "isExpired"
      for            = "5m"
      exec_err_state = "Error"
      no_data_state  = "NoData"

      annotations = {
        summary = "The {{ $labels.rateFeed }} rate feed is stale on {{ $labels.chain | title }}. Check for possible issues with the oracle relayer."
      }

      labels = {
        service  = "oracle-relayers"
        severity = rule.value.env == "prod" ? "page" : "warning"
        # Consumed by the Slack template to build per-explorer links to the
        # relayer signer wallet.
        explorer = rule.value.explorer
      }

      data {
        ref_id         = "oldestReportStatus"
        datasource_uid = "grafanacloud-prom"

        relative_time_range {
          from = 600
          to   = 0
        }

        model = jsonencode({
          refId   = "oldestReportStatus"
          expr    = "SortedOracles_isOldestReportExpired_isExpired{chain=\"${rule.key}\"}"
          instant = true
        })
      }
      data {
        ref_id         = "isExpired"
        datasource_uid = "__expr__"

        relative_time_range {
          from = 0
          to   = 0
        }

        model = jsonencode({
          refId = "isExpired"
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
                params = ["isExpired"]
              }
            }
          ]
          datasource = {
            type = "__expr__"
            uid  = "__expr__"
          }
          expression = "oldestReportStatus"
          type       = "threshold"
        })
      }
    }
  }

  dynamic "rule" {
    for_each = local.chains

    content {
      name           = "Low ${rule.value.symbol} Balance [${rule.value.title}]"
      condition      = "belowThreshold"
      for            = "1m" // Alert if balance is low for at least 1 minutes
      exec_err_state = "Error"
      no_data_state  = "NoData"

      annotations = {
        summary        = "Low ${rule.value.symbol} balance for {{ $labels.owner }} on {{ $labels.chain | title }}: {{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }} ${rule.value.symbol}"
        currentBalance = "{{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }}"
      }

      labels = {
        service  = "oracle-relayers"
        severity = rule.value.env == "prod" ? "warning" : "info"
        # Consumed by the Slack/VictorOps templates to render
        # token-aware copy and per-chain explorer links.
        token    = rule.value.symbol
        explorer = rule.value.explorer
      }

      data {
        ref_id         = "balanceOfRaw"
        datasource_uid = "grafanacloud-prom"
        relative_time_range {
          from = 600
          to   = 0
        }
        model = jsonencode({
          # NOTE: Grafana syntax is a bit confusing here in that 'expr' and 'expression' mean different things
          # PromQL query fetching the native gas-token balance for all RelayerSigner accounts on this chain
          expr  = "${rule.value.metric}{chain=\"${rule.key}\", owner=~\"^RelayerSigner.*\"}"
          refId = "balanceOfRaw"
        })
      }
      data {
        ref_id         = "balance"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          # Reduce the per-owner balance series to a single value per alert instance
          expression = "balanceOfRaw",
          type       = "reduce",
          reducer    = "last",
          refId      = "balance"
        })
      }
      data {
        ref_id         = "belowThreshold"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          type       = "threshold",
          expression = "balance",
          refId      = "belowThreshold"
          conditions = [
            {
              evaluator = {
                params = [rule.value.threshold],
                type   = "lt",
              },
              operator = {
                type = "and",
              },
              reducer = {
                params = [],
                type   = "last",
              },
              type = "query",
            },
          ],
        })
      }
    }
  }
}
