# VirtualPool oracle freshness. VPs use each wrapped exchange's
# referenceRateResetFrequency as the expected oracle-update window, intentionally
# separate from FPMM SortedOracles expiry alerts.

locals {
  vp_oracle_fresh_testnet_promql = "mento_pool_vp_oracle_fresh{chain_name=~\"celo-sepolia|monad-testnet\"}"
  vp_oracle_fresh_prod_promql    = "mento_pool_vp_oracle_fresh{chain_name=\"celo\"}"

  vp_oracle_fresh_testnet_fx_pause_promql = "(1 - mento_pool_vp_oracle_fresh{chain_name=~\"celo-sepolia|monad-testnet\", pair!~\"${local.usd_pegged_pair_regex}\", pair=~\".+/.+\"}) and on() ${local.fx_oracle_pause_gate_promql}"
  vp_oracle_fresh_prod_fx_pause_promql    = "(1 - mento_pool_vp_oracle_fresh{chain_name=\"celo\", pair!~\"${local.usd_pegged_pair_regex}\", pair=~\".+/.+\"}) and on() ${local.fx_oracle_pause_gate_promql}"
}

resource "grafana_rule_group" "vp_oracle_staleness" {
  name             = "VirtualPool Oracle Freshness"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  rule {
    name           = "VirtualPool Oracle Stale (testnet)"
    condition      = "threshold"
    for            = "2m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      title            = "VirtualPool Oracle Stale"
      summary          = "A testnet VirtualPool oracle report is older than its on-chain reset frequency, so swaps may revert."
      resolved_title   = "VirtualPool Oracle Recovered"
      resolved_summary = "The VirtualPool oracle report is fresh again."
    }

    labels = {
      service  = "fpmms"
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
        expr    = "(1 - ${local.vp_oracle_fresh_testnet_promql}) unless on(chain_id, pool_id, pair) (${local.vp_oracle_fresh_testnet_fx_pause_promql})"
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
          evaluator = { params = [0.5], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_vp_oracle_testnet.contact_point
      group_by        = local.notify_vp_oracle_testnet.group_by
      group_wait      = local.notify_vp_oracle_testnet.group_wait
      group_interval  = local.notify_vp_oracle_testnet.group_interval
      repeat_interval = local.notify_vp_oracle_testnet.repeat_interval
    }
  }

  rule {
    name           = "VirtualPool Oracle Stale (prod)"
    condition      = "threshold"
    for            = "2m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      title            = "VirtualPool Oracle Stale"
      summary          = "A production VirtualPool oracle report is older than its on-chain reset frequency, so swaps may revert."
      resolved_title   = "VirtualPool Oracle Recovered"
      resolved_summary = "The VirtualPool oracle report is fresh again."
    }

    labels = {
      service  = "fpmms"
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
        expr    = "(1 - ${local.vp_oracle_fresh_prod_promql}) unless on(chain_id, pool_id, pair) (${local.vp_oracle_fresh_prod_fx_pause_promql})"
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
          evaluator = { params = [0.5], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_critical_pool.contact_point
      group_by        = local.notify_critical_pool.group_by
      group_wait      = local.notify_critical_pool.group_wait
      group_interval  = local.notify_critical_pool.group_interval
      repeat_interval = local.notify_critical_pool.repeat_interval
    }
  }
}
