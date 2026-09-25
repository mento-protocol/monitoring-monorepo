resource "grafana_rule_group" "reserve_balances" {
  name             = "Reserve Balance Alerts"
  folder_uid       = local.external_folder_uids.reserve
  interval_seconds = 120

  dynamic "rule" {
    for_each = {
      # Removed CELO because it's not being actively managed in the Reserve at the moment
      # trunk-ignore(checkov/CKV_SECRET_6)
      # CELO    = { token = "CELOToken", threshold = 5000000 }
      USDC    = { token = "USDC", threshold = 90000 }
      USDT    = { token = "USDT", threshold = 90000 }
      axlUSDC = { token = "axlUSDC", threshold = 50000 }
    }
    content {
      name      = "Low ${rule.key} Reserve Balance Alert"
      condition = "lowerThan${rule.value.threshold / 1000000}m${rule.key}"

      # Threshold must be breached for at least 1 hour. Using the default 1m could get very noisy.
      # Because due to trades in both directions, it could temporarily dip below the threshold and
      # then back above it many times, causing a lot of alerts.
      for            = "60m"
      exec_err_state = "Error"
      no_data_state  = "NoData"

      annotations = {
        summary        = "Low ${rule.key} Reserve Balance: {{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }} ${rule.key}"
        threshold      = "{{ humanize (${rule.value.threshold}) }}"
        currentBalance = "{{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }} ${rule.key}"
      }
      labels = {
        service  = "reserve"
        severity = "warning"
        token    = rule.value.token
        explorer = "celoscan.io"
      }

      data {
        ref_id         = "a"
        datasource_uid = "grafanacloud-prom"
        relative_time_range {
          from = 600
          to   = 0
        }
        model = jsonencode({
          expr  = "${rule.value.token}_balanceOf{chain=\"celo\", owner=\"Reserve\"}"
          refId = "a"
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
          expression = "a"
          type       = "reduce"
          reducer    = "last"
          refId      = "balance"
        })
      }
      data {
        ref_id         = "lowerThan${rule.value.threshold / 1000000}m${rule.key}"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          type       = "threshold"
          expression = "balance"
          refId      = "lowerThan${rule.value.threshold / 1000000}m${rule.key}"
          conditions = [{
            evaluator = {
              params = [rule.value.threshold]
              type   = "lt"
            }
            operator = {
              type = "and"
            }
            reducer = {
              params = []
              type   = "last"
            }
            type = "query"
          }]
        })
      }
    }
  }

  # Polygon's Reserve-backed pools cannot expand when their corresponding
  # ReserveV2 collateral balance is exactly zero. Keep this predicate strictly
  # zero-only; the nonzero Polygon floors live in the ReserveV2 floor rules
  # below.
  dynamic "rule" {
    for_each = {
      USDC = { metric = "USDC_balanceOf", token = "USDC" }
    }

    content {
      name           = "Empty ${rule.key} Reserve Balance Alert [Polygon]"
      condition      = "threshold"
      for            = "5m"
      exec_err_state = "Error"
      no_data_state  = "NoData"

      annotations = {
        summary        = "Polygon ReserveV2 has no ${rule.key} collateral available for Reserve-backed pool expansion."
        threshold      = "0"
        currentBalance = "{{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }} ${rule.key}"
      }
      labels = {
        service  = "reserve"
        severity = "page"
        token    = rule.value.token
        chain    = "polygon"
        explorer = "polygonscan.com"
      }

      data {
        ref_id         = "a"
        datasource_uid = "grafanacloud-prom"
        relative_time_range {
          from = 600
          to   = 0
        }
        model = jsonencode({
          expr  = "${rule.value.metric}{chain=\"polygon\", owner=\"Reserve\"}"
          refId = "a"
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
          expression = "a"
          type       = "reduce"
          reducer    = "last"
          refId      = "balance"
        })
      }
      data {
        ref_id         = "isZeroRaw"
        datasource_uid = "grafanacloud-prom"
        relative_time_range {
          from = 600
          to   = 0
        }
        model = jsonencode({
          # The bool modifier converts exactly-zero to 1 and every positive
          # value to 0 while preserving the source labels. This is stricter
          # than approximating zero with a sub-token floating threshold.
          expr  = "${rule.value.metric}{chain=\"polygon\", owner=\"Reserve\"} == bool 0"
          refId = "isZeroRaw"
        })
      }
      data {
        ref_id         = "isZero"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          expression = "isZeroRaw"
          type       = "reduce"
          reducer    = "last"
          refId      = "isZero"
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
          type       = "threshold"
          expression = "isZero"
          refId      = "threshold"
          conditions = [{
            evaluator = {
              params = [0.5]
              type   = "gt"
            }
            operator = { type = "and" }
            reducer  = { params = [], type = "last" }
            type     = "query"
          }]
        })
      }
    }
  }

  # Nonzero ReserveV2 floors for Monad and Polygon (#1332), two levels per
  # token. The warning predicate is `critical <= balance < warning`, so one
  # breach notifies at one level only; this stack has no inhibition rules.
  # When a balance moves between bands, one rule resolves and the other waits
  # its own 60m `for`. The `band` annotation makes the Slack resolve copy
  # neutral instead of claiming a recovery.
  dynamic "rule" {
    for_each = local.reserve_floor_rules

    content {
      name           = rule.value.name
      condition      = "isLow"
      for            = "60m"
      exec_err_state = "Error"
      no_data_state  = "NoData"

      annotations = {
        summary        = "${rule.value.name}: {{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }} ${rule.value.token}"
        threshold      = "{{ humanize (${rule.value.threshold}) }}"
        currentBalance = "{{ with (index $values \"balance\") }}{{ humanize .Value }}{{ else }}unknown{{ end }} ${rule.value.token}"
        # Static on purpose: Grafana can carry the alerting values into a
        # resolved alert, so the resolve copy must not classify by balance.
        band = rule.value.severity
      }
      labels = {
        service  = "reserve"
        severity = rule.value.severity
        token    = rule.value.token
        chain    = rule.value.chain
        explorer = local.chains[rule.value.chain].explorer
      }

      data {
        ref_id         = "a"
        datasource_uid = "grafanacloud-prom"
        relative_time_range {
          from = 600
          to   = 0
        }
        model = jsonencode({
          expr  = "${rule.value.token}_balanceOf{chain=\"${rule.value.chain}\", owner=\"Reserve\"}"
          refId = "a"
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
          expression = "a"
          type       = "reduce"
          reducer    = "last"
          refId      = "balance"
        })
      }
      data {
        ref_id         = "isLow"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          type       = "math"
          expression = rule.value.expression
          refId      = "isLow"
        })
      }
    }
  }
}

locals {
  # Whole token units: warning ~90% and critical 50% of each token's 30-day
  # minimum Reserve balance, read 2026-09-25 (#1332). Polygon EUROP reads 0 by
  # design and has no floor.
  reserve_balance_floors = {
    monad = {
      USDC  = { warning = 70000, critical = 40000 }
      USDT0 = { warning = 180000, critical = 100000 }
      AUSD  = { warning = 600000, critical = 300000 }
    }
    polygon = {
      USDC = { warning = 100000, critical = 60000 }
    }
  }

  reserve_floor_rules = merge(flatten([
    for chain, tokens in local.reserve_balance_floors : [
      for token, floor in tokens : {
        "${chain}-${token}-warning" = {
          name       = "Low ${token} Reserve Balance Alert [${local.chains[chain].title}]"
          severity   = "warning"
          threshold  = floor.warning
          expression = "$balance >= ${floor.critical} && $balance < ${floor.warning}"
          chain      = chain
          token      = token
        }
        "${chain}-${token}-critical" = {
          name     = "Critical ${token} Reserve Balance Alert [${local.chains[chain].title}]"
          severity = "critical"
          # The Slack copy says "top up above" this value. Point it at the
          # warning floor so a top-up does not stop inside the warning band.
          threshold  = floor.warning
          expression = "$balance < ${floor.critical}"
          chain      = chain
          token      = token
        }
      }
    ]
  ])...)
}
