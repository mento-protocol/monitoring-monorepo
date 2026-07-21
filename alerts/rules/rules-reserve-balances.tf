resource "grafana_rule_group" "reserve_balances" {
  name             = "Reserve Balance Alerts"
  folder_uid       = local.external_folder_uids.reserve
  interval_seconds = 120

  dynamic "rule" {
    for_each = {
      # Removed CELO because it's not being actively managed in the Reserve at the moment
      # trunk-ignore(checkov/CKV_SECRET_6)
      # CELO    = { token = "CELOToken", threshold = 5000000 }
      USDC    = { token = "USDC", threshold = 100000 }
      USDT    = { token = "USDT", threshold = 100000 }
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
  # zero-only; nonzero operational floors still require treasury SLOs and stay
  # tracked in #1332 rather than being guessed here.
  dynamic "rule" {
    for_each = {
      USDC  = { metric = "USDC_balanceOf", token = "USDC" }
      EUROP = { metric = "EUROP_balanceOf", token = "EUROP" }
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
}
