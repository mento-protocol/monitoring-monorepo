# service=cdps alert rules — Mento CDP markets (Liquity v2 forks: GBPm / CHFm
# / JPYm on Celo). Closes #702.
#
# Data path: indexer (LiquityInstance/LiquityCollateral) → metrics-bridge
# `mento_cdp_*` gauges (see metrics-bridge/src/cdp-metrics.ts) → Prometheus →
# these rules. Every CDP series carries {symbol, chain_id, chain_name,
# collateral_id, block_explorer_url}; `collateral_id` ("{chainId}-{troveManager}")
# is the per-market grouping key (CDP markets are not FPMM pools, so there is
# no pool_id here).
#
# Routing: criticals → #alerts-critical (notify_critical_cdps); warnings →
# #alerts-cdps (notify_warning_cdps). See contact-points.tf.
#
# no_data_state / exec_err_state = "OK" on every rule: a missing CDP gauge
# (deploy-window rollout before the bridge ships, or a stale series after the
# bridge restarts) must NOT page. Bridge liveness is owned by the
# metrics-bridge poll-staleness alert; absence of CDP data is never itself a
# CDP emergency.
#
# NOT covered here (deliberate): TCR / ICR rules. `LiquityInstance.tcrBps`,
# `icrP1Bps`, and `icrFracBelowMcrBps` are hardcoded −1 sentinels in the
# current indexer (no collateral-price read is wired), so a TCR threshold would
# fire on garbage. Deferred until the indexer computes a real TCR; the issue's
# acceptance criteria do not include it.
#
# Thresholds below are the product-signed-off initial set (issue #702 grooming,
# 2026-06-02). All non-flapping against current prod data (SP/debt 3–7%, 0
# liquidations, 0 shortfalls, no shutdowns).

resource "grafana_rule_group" "cdps" {
  name             = "CDP Alerts"
  folder_uid       = grafana_folder.cdps.uid
  interval_seconds = 60

  # ── 1. System Shutdown (critical) ────────────────────────────────────────
  # `BorrowerOperations.ShutDown(uint256 _tcr)` fired — the system fell below
  # SCR. Borrowing is permanently disabled for the market. Pages immediately.
  rule {
    name           = "CDP System Shutdown"
    condition      = "threshold"
    for            = "1m"
    no_data_state  = "OK"
    exec_err_state = "OK"

    annotations = {
      summary     = "CDP market {{ $labels.symbol }} has SHUT DOWN."
      description = "Liquity ShutDown fired — the market's collateral ratio fell below SCR. New borrowing is disabled; only redemptions and trove closures remain. Investigate the USDm collateral feed and reserve impact immediately."
    }
    labels = {
      service  = "cdps"
      severity = "critical"
    }

    data {
      ref_id         = "metric"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "metric"
        instant = true
        expr    = "mento_cdp_shutdown"
      })
    }
    data {
      ref_id         = "reduced"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "reduced"
        type       = "reduce"
        reducer    = "last"
        expression = "metric"
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
        expression = "reduced"
        conditions = [{
          evaluator = { params = [0.5], type = "gt" }
          operator  = { type = "and" }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
      })
    }

    notification_settings {
      contact_point   = local.notify_critical_cdps.contact_point
      group_by        = local.notify_critical_cdps.group_by
      group_wait      = local.notify_critical_cdps.group_wait
      group_interval  = local.notify_critical_cdps.group_interval
      repeat_interval = local.notify_critical_cdps.repeat_interval
    }
  }

  # ── 2. Stability Pool Below Floor (critical) ─────────────────────────────
  # `spHeadroom = spDeposits − MIN_BOLD_IN_SP` went negative: the SP is below
  # the on-chain governance floor, so liquidation-absorption capacity is
  # exhausted. The gauge is withheld until SystemParams is loaded (sentinel
  # guard in the bridge), so a negative read is always a real breach. 15m
  # dwell absorbs transient dips around the floor.
  rule {
    name           = "CDP Stability Pool Below Floor"
    condition      = "threshold"
    for            = "15m"
    no_data_state  = "OK"
    exec_err_state = "OK"

    annotations = {
      summary     = "{{ $labels.symbol }} Stability Pool is below its minimum buffer (headroom {{ with $values.reduced }}{{ humanize .Value }}{{ else }}unknown{{ end }} {{ $labels.symbol }})."
      description = "SP deposits fell to/below the on-chain MIN_BOLD_IN_SP floor. Liquidation-absorption capacity is exhausted — further liquidations will redistribute debt to the remaining troves instead of being offset by the pool."
    }
    labels = {
      service  = "cdps"
      severity = "critical"
    }

    data {
      ref_id         = "metric"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "metric"
        instant = true
        expr    = "mento_cdp_sp_headroom"
      })
    }
    data {
      ref_id         = "reduced"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "reduced"
        type       = "reduce"
        reducer    = "last"
        expression = "metric"
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
        expression = "reduced"
        conditions = [{
          evaluator = { params = [0], type = "lt" }
          operator  = { type = "and" }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
      })
    }

    notification_settings {
      contact_point   = local.notify_critical_cdps.contact_point
      group_by        = local.notify_critical_cdps.group_by
      group_wait      = local.notify_critical_cdps.group_wait
      group_interval  = local.notify_critical_cdps.group_interval
      repeat_interval = local.notify_critical_cdps.repeat_interval
    }
  }

  # ── 3. Stability Pool Thin (warning) ─────────────────────────────────────
  # SP deposits below 2% of system debt — early-warning on absorption capacity,
  # well before the floor breach above. Measured against system debt per the
  # issue's chosen basis. 2% sits just under today's lowest market (GBPm 3.0%).
  # 30m dwell since the ratio drifts with every borrow/redeem.
  rule {
    name           = "CDP Stability Pool Thin"
    condition      = "threshold"
    for            = "30m"
    no_data_state  = "OK"
    exec_err_state = "OK"

    annotations = {
      summary = "{{ $labels.symbol }} Stability Pool deposits are {{ with $values.reduced }}{{ humanizePercentage .Value }}{{ else }}an unknown share{{ end }} of system debt (below 2%)."
    }
    labels = {
      service  = "cdps"
      severity = "warning"
    }

    data {
      ref_id         = "metric"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "metric"
        instant = true
        # one-to-one match: both series carry identical CDP labels, so the
        # ratio keeps symbol/chain_name/collateral_id for routing + annotation.
        expr = "mento_cdp_sp_deposits / mento_cdp_system_debt"
      })
    }
    data {
      ref_id         = "reduced"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "reduced"
        type       = "reduce"
        reducer    = "last"
        expression = "metric"
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
        expression = "reduced"
        conditions = [{
          evaluator = { params = [0.02], type = "lt" }
          operator  = { type = "and" }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
      })
    }

    notification_settings {
      contact_point   = local.notify_warning_cdps.contact_point
      group_by        = local.notify_warning_cdps.group_by
      group_wait      = local.notify_warning_cdps.group_wait
      group_interval  = local.notify_warning_cdps.group_interval
      repeat_interval = local.notify_warning_cdps.repeat_interval
    }
  }

  # ── 4. Liquidations Detected (warning) ───────────────────────────────────
  # Any liquidation in the last hour. CDP markets have had 0 liquidations ever,
  # so even one is worth surfacing. `increase()` over the bridged cumulative
  # counter; a constant counter yields 0 (no false fire). Caveat: an indexer
  # re-sync replays the counter and can briefly false-fire — acceptable at
  # warning severity.
  rule {
    name           = "CDP Liquidations Detected"
    condition      = "threshold"
    for            = "0m"
    no_data_state  = "OK"
    exec_err_state = "OK"

    annotations = {
      summary = "{{ $labels.symbol }}: {{ with $values.reduced }}{{ humanize .Value }}{{ else }}one or more{{ end }} liquidation(s) in the last hour."
    }
    labels = {
      service  = "cdps"
      severity = "warning"
    }

    data {
      ref_id         = "metric"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 3600
        to   = 0
      }
      model = jsonencode({
        refId   = "metric"
        instant = true
        expr    = "increase(mento_cdp_liquidation_total[1h])"
      })
    }
    data {
      ref_id         = "reduced"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "reduced"
        type       = "reduce"
        reducer    = "last"
        expression = "metric"
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
        expression = "reduced"
        # > 0.5 robustly catches a single event despite increase() extrapolation.
        conditions = [{
          evaluator = { params = [0.5], type = "gt" }
          operator  = { type = "and" }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
      })
    }

    notification_settings {
      contact_point   = local.notify_warning_cdps.contact_point
      group_by        = local.notify_warning_cdps.group_by
      group_wait      = local.notify_warning_cdps.group_wait
      group_interval  = local.notify_warning_cdps.group_interval
      repeat_interval = local.notify_warning_cdps.repeat_interval
    }
  }

  # ── 5. User Redemptions Detected (warning) ───────────────────────────────
  # Any USER (non-rebalance) redemption in the last hour. The bridge already
  # subtracts the CDPLiquidityStrategy rebalance subset, so this excludes the
  # ~100%-rebalance-driven redemption noise on production. Same increase()
  # mechanics + re-sync caveat as the liquidation rule.
  rule {
    name           = "CDP User Redemptions Detected"
    condition      = "threshold"
    for            = "0m"
    no_data_state  = "OK"
    exec_err_state = "OK"

    annotations = {
      summary = "{{ $labels.symbol }}: {{ with $values.reduced }}{{ humanize .Value }}{{ else }}one or more{{ end }} user redemption(s) in the last hour (excludes rebalancer)."
    }
    labels = {
      service  = "cdps"
      severity = "warning"
    }

    data {
      ref_id         = "metric"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 3600
        to   = 0
      }
      model = jsonencode({
        refId   = "metric"
        instant = true
        expr    = "increase(mento_cdp_user_redemption_total[1h])"
      })
    }
    data {
      ref_id         = "reduced"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "reduced"
        type       = "reduce"
        reducer    = "last"
        expression = "metric"
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
        expression = "reduced"
        conditions = [{
          evaluator = { params = [0.5], type = "gt" }
          operator  = { type = "and" }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
      })
    }

    notification_settings {
      contact_point   = local.notify_warning_cdps.contact_point
      group_by        = local.notify_warning_cdps.group_by
      group_wait      = local.notify_warning_cdps.group_wait
      group_interval  = local.notify_warning_cdps.group_interval
      repeat_interval = local.notify_warning_cdps.repeat_interval
    }
  }

  # ── 6. Redemption Shortfall Subsidized (critical) ────────────────────────
  # `CDPLiquidityStrategy.RedemptionShortfallSubsidized` fired — the protocol
  # absorbed a redemption shortfall, a direct economic loss. 0 have occurred.
  # 6h window so a subsidy stays visible long enough to action; increase() over
  # the bridged cumulative subsidy amount (debt-token units). Same re-sync
  # caveat as the activity rules: a post-subsidy indexer re-sync replays the
  # cumulative and can re-page. Harmless until a real subsidy lands (cum is 0
  # today), but a critical re-page on re-sync is the accepted trade-off for
  # never missing a real economic loss.
  rule {
    name           = "CDP Redemption Shortfall Subsidized"
    condition      = "threshold"
    for            = "0m"
    no_data_state  = "OK"
    exec_err_state = "OK"

    annotations = {
      summary     = "{{ $labels.symbol }}: protocol absorbed a redemption shortfall ({{ with $values.reduced }}{{ humanize .Value }}{{ else }}unknown{{ end }} {{ $labels.symbol }}) in the last 6h."
      description = "RedemptionShortfallSubsidized fired — the protocol covered a redemption shortfall via CDPLiquidityStrategy, a direct economic loss to the reserve. Review the rebalance flow and reserve drawdown for this market."
    }
    labels = {
      service  = "cdps"
      severity = "critical"
    }

    data {
      ref_id         = "metric"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 21600
        to   = 0
      }
      model = jsonencode({
        refId   = "metric"
        instant = true
        expr    = "increase(mento_cdp_shortfall_subsidy_total[6h])"
      })
    }
    data {
      ref_id         = "reduced"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "reduced"
        type       = "reduce"
        reducer    = "last"
        expression = "metric"
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
        expression = "reduced"
        # > 0 (not the > 0.5 used by the liquidation/redemption rules above):
        # shortfall is a debt-token AMOUNT, not an integer event count, so any
        # non-zero value is a real loss — > 0.5 would silently miss a
        # sub-half-token shortfall.
        conditions = [{
          evaluator = { params = [0], type = "gt" }
          operator  = { type = "and" }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
      })
    }

    notification_settings {
      contact_point   = local.notify_critical_cdps.contact_point
      group_by        = local.notify_critical_cdps.group_by
      group_wait      = local.notify_critical_cdps.group_wait
      group_interval  = local.notify_critical_cdps.group_interval
      repeat_interval = local.notify_critical_cdps.repeat_interval
    }
  }
}
