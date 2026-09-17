resource "grafana_rule_group" "oracle_relayers" {
  name             = "Oracle Relayer Alerts"
  folder_uid       = grafana_folder.oracle_relayers.uid
  interval_seconds = 120

  dynamic "rule" {
    for_each = local.chains

    content {
      name      = "Oldest Report Expired [${rule.value.title}]"
      condition = "isExpired"
      for       = "5m"
      # A relayer that catches up for one evaluation and falls behind again
      # resolves and re-fires this rule; Celo alone logged 30 such transitions
      # across roughly three incidents in two weeks. Hold the incident open for
      # 30m — long enough to absorb the catch-up cycle, short enough that a real
      # recovery still resolves within the relayer's report cadence.
      keep_firing_for = "30m"
      exec_err_state  = "Error"
      no_data_state   = "NoData"

      annotations = {
        summary = "{{ $labels.rateFeed }} oracle report expired on {{ $labels.chain | title }}. Swaps using this feed may revert. {{ if and (or (eq $labels.chain \"polygon\") (eq $labels.chain \"polygon-testnet\")) (eq $labels.rateFeed \"EUROPEUR\") }}Check the deployment/migration owner responsible for the fixed 1.0 SortedOracles report.{{ else }}Check whether the oracle relayer is executing and inspect errors for this feed.{{ end }}"
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

  # Relayer signer wallets: one rule per chain, plus one per signer class whose
  # burn differs from the chain default (see local.signer_balance_rules). The
  # threshold is ~5 days of that class's relay burn. The daily refill tops a
  # signer up below 7 days, so this firing means the automation is not keeping up.
  dynamic "rule" {
    for_each = local.signer_balance_rules

    content {
      name           = rule.value.name
      condition      = "belowThreshold"
      for            = "1m"
      exec_err_state = "Error"
      no_data_state  = "NoData"

      annotations = {
        summary        = "Low ${rule.value.chain.symbol} balance for {{ $labels.owner }} on {{ $labels.chain | title }}: {{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }} ${rule.value.chain.symbol}"
        currentBalance = "{{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }}"
        threshold      = tostring(rule.value.threshold)
      }

      labels = {
        service  = "oracle-relayers"
        severity = rule.value.chain.env == "prod" ? "warning" : "info"
        # Consumed by the Slack/VictorOps templates to render
        # token-aware copy and per-chain explorer links.
        token    = rule.value.chain.symbol
        explorer = rule.value.chain.explorer
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
          expr  = "${rule.value.chain.metric}{chain=\"${rule.value.chain_key}\", owner=~\"${rule.value.include}\", owner!~\"${rule.value.exclude}\"}"
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

  # Refiller wallet: the account the daily refill-relayers cloud functions pay
  # signer top-ups from (oracle-relayer repo). Fires below ~14 days of the
  # chain's relay burn (see local.refiller_balance_rules). Signers hold at
  # least 7 days each, so relays are not at risk when this first fires.
  dynamic "rule" {
    for_each = local.refiller_balance_rules

    content {
      name           = rule.value.name
      condition      = "belowThreshold"
      for            = "5m"
      exec_err_state = "Error"
      # OK rather than NoData: the series only exists once Aegis has deployed
      # the RelayerRefiller owner, and the Aegis deploy and this stack's apply
      # start independently on merge. Aegis going dark is covered by its own
      # liveness alerts, and relayer-balance-alerts.tftest.hcl fails if the
      # owner ever disappears from aegis/config.yaml.
      no_data_state = "OK"

      annotations = {
        summary        = "Low ${rule.value.chain.symbol} balance in the relayer refiller wallet on {{ $labels.chain | title }}: {{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }} ${rule.value.chain.symbol}"
        currentBalance = "{{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }}"
        threshold      = tostring(rule.value.threshold)
        runwayDays     = "{{ with (index $values \"runwayDays\") }}{{ printf \"%.0f\" .Value }}{{ else }}unknown{{ end }}"
        monthlyBurn    = tostring(rule.value.monthly_burn)
      }

      labels = {
        service  = "oracle-relayers"
        severity = rule.value.chain.env == "prod" ? "warning" : "info"
        # Consumed by the Slack/VictorOps templates to render
        # token-aware copy and per-chain explorer links.
        token    = rule.value.chain.symbol
        explorer = rule.value.chain.explorer
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
          expr  = "${rule.value.chain.metric}{chain=\"${rule.key}\", owner=\"RelayerRefiller\"}"
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
        ref_id         = "runwayDaysRaw"
        datasource_uid = "grafanacloud-prom"
        relative_time_range {
          from = 600
          to   = 0
        }
        model = jsonencode({
          # Annotation only: the balance expressed as days of refills. Derived
          # from the same series as the alert query, so it cannot go NoData
          # while the base query still has data.
          expr  = "${rule.value.chain.metric}{chain=\"${rule.key}\", owner=\"RelayerRefiller\"} / ${rule.value.daily_burn}"
          refId = "runwayDaysRaw"
        })
      }
      data {
        ref_id         = "runwayDays"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          expression = "runwayDaysRaw",
          type       = "reduce",
          reducer    = "last",
          refId      = "runwayDays"
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
