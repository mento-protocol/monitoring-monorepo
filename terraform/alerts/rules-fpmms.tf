# Alert rules for FPMM pool health (oracle liveness, deviation breach, trading
# limit pressure, rebalancer liveness). All rules attach `service = "fpmms"`
# so a future policy-tree split can route them without relabelling.
#
# Each rule sets `notification_settings` directly — bypasses the Aegis-owned
# root policy and sends straight to the Slack contact points defined in
# contact-points.tf.
#
# `no_data_state = "OK"` on every rule: absence of data shouldn't fire here,
# that's what the separate metrics-bridge rule group is for.

# ── Oracle liveness ──────────────────────────────────────────────────────────
resource "grafana_rule_group" "fpmms_oracle" {
  name             = "Oracle Liveness"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  rule {
    name           = "Oracle Liveness"
    condition      = "threshold"
    for            = "2m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Live-ratio {{ printf \"%.2f\" $values.A.Value }} — next oracle report is overdue."
      description = "`(time() - oracle_timestamp) / oracle_expiry` crossed 0.8. If the next report does not land the pool will flip to oracle-down."
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
        expr    = "(time() - mento_pool_oracle_timestamp) / (mento_pool_oracle_expiry > 0)"
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
          evaluator = { params = [0.8], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_warning.contact_point
      group_by        = local.notify_warning.group_by
      group_wait      = local.notify_warning.group_wait
      group_interval  = local.notify_warning.group_interval
      repeat_interval = local.notify_warning.repeat_interval
    }
  }

  # KPI 1 critical has two triggers in the spec: can-trade=false OR
  # liveness-ratio ≥ 1. Split into two rules so Slack messages name the
  # precise failure mode (and so one rule firing doesn't hide a lagging
  # second signal).
  rule {
    name           = "Oracle Down"
    condition      = "threshold"
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Oracle is not usable — swaps will revert."
      description = "`mento_pool_oracle_ok = 0` — indexer flagged the oracle as not usable. Swaps on this pool revert until the relayer pushes a fresh report."
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
        expr    = "mento_pool_oracle_ok"
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
          evaluator = { params = [0.5], type = "lt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_critical.contact_point
      group_by        = local.notify_critical.group_by
      group_wait      = local.notify_critical.group_wait
      group_interval  = local.notify_critical.group_interval
      repeat_interval = local.notify_critical.repeat_interval
    }
  }

  rule {
    name           = "Oracle Expired"
    condition      = "threshold"
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Liveness ratio {{ printf \"%.2f\" $values.A.Value }} ≥ 1 — last oracle report past expiry."
      description = "If this fires while `Oracle Down` stays quiet, the indexer's `oracleOk` derivation has drifted from the on-chain expiry check."
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
        expr    = "(time() - mento_pool_oracle_timestamp) / (mento_pool_oracle_expiry > 0)"
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
          evaluator = { params = [1.0], type = "gte" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_critical.contact_point
      group_by        = local.notify_critical.group_by
      group_wait      = local.notify_critical.group_wait
      group_interval  = local.notify_critical.group_interval
      repeat_interval = local.notify_critical.repeat_interval
    }
  }
}

# ── Deviation breach ─────────────────────────────────────────────────────────
resource "grafana_rule_group" "fpmms_deviation" {
  name             = "Deviation Breach"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  # KPI 2 warn: "≥ 1 for > 15 min" per spec §3. The 15m hold matches the spec
  # verbatim — shorter durations produce weekend-flicker noise on FX pools.
  rule {
    name           = "Deviation Breach"
    condition      = "threshold"
    for            = "15m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Deviation ratio {{ printf \"%.2f\" $values.A.Value }} — mid-price out of rebalance band."
      description = "Rebalancer should act. If the breach persists past 60 min, the Deviation Breach Critical rule fires."
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
        expr    = "mento_pool_deviation_ratio"
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
          evaluator = { params = [1.0], type = "gte" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_warning.contact_point
      group_by        = local.notify_warning.group_by
      group_wait      = local.notify_warning.group_wait
      group_interval  = local.notify_warning.group_interval
      repeat_interval = local.notify_warning.repeat_interval
    }
  }

  # Fallback warning for the window where the indexer has anchored a breach
  # (`deviationBreachStartedAt > 0`) but the bridge is NOT publishing
  # `mento_pool_deviation_ratio` — this happens whenever `lastDeviationRatio`
  # is the `-1` sentinel (see metrics-bridge/src/metrics.ts:110). The indexer
  # treats the anchor as the authoritative breach signal (see
  # indexer-envio/src/deviationBreach.ts comment at L98-107), so this rule
  # exists to keep warning coverage continuous across ratio gaps.
  rule {
    name           = "Deviation Breach (anchored)"
    condition      = "threshold"
    for            = "15m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Breach anchored for {{ humanizeDuration $values.A.Value }} — ratio gauge missing."
      description = "`mento_pool_deviation_breach_start > 0` but `mento_pool_deviation_ratio` is absent (bridge emitted the `-1` sentinel). The anchor is the indexer's authoritative breach signal, so the breach is real even when the ratio gauge is missing."
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
        expr    = "(time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0) unless on(chain_id, pool_id, pair) mento_pool_deviation_ratio"
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
      contact_point   = local.notify_warning.contact_point
      group_by        = local.notify_warning.group_by
      group_wait      = local.notify_warning.group_wait
      group_interval  = local.notify_warning.group_interval
      repeat_interval = local.notify_warning.repeat_interval
    }
  }

  rule {
    name           = "Deviation Breach Critical"
    condition      = "threshold"
    for            = "0s"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Deviating for {{ humanizeDuration $values.A.Value }} — rebalancer not resolving breach."
      description = "Breach has persisted longer than 60 min. Manual investigation required — check rebalancer liveness and oracle feed."
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    # The Prometheus expression: seconds since breach started, but only where a
    # breach is actually active (breach_start > 0). When there is no breach,
    # the series is dropped — threshold below never sees it.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = "(time() - mento_pool_deviation_breach_start) and (mento_pool_deviation_breach_start > 0)"
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
          evaluator = { params = [3600], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_critical.contact_point
      group_by        = local.notify_critical.group_by
      group_wait      = local.notify_critical.group_wait
      group_interval  = local.notify_critical.group_interval
      repeat_interval = local.notify_critical.repeat_interval
    }
  }
}

# ── Trading limit pressure ───────────────────────────────────────────────────
resource "grafana_rule_group" "fpmms_trading_limit" {
  name             = "Trading Limit Pressure"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  rule {
    name           = "Trading Limit Pressure"
    condition      = "threshold"
    for            = "5m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "token{{ $labels.token_index }} limit at {{ humanizePercentage $values.A.Value }} — trip imminent."
      description = "Trading limit is about to trip. Next swap at this size will revert."
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
        expr    = "mento_pool_limit_pressure"
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
          evaluator = { params = [0.8], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_warning.contact_point
      group_by        = local.notify_warning.group_by
      group_wait      = local.notify_warning.group_wait
      group_interval  = local.notify_warning.group_interval
      repeat_interval = local.notify_warning.repeat_interval
    }
  }

  rule {
    name           = "Trading Limit Tripped"
    condition      = "threshold"
    for            = "2m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "token{{ $labels.token_index }} limit at {{ humanizePercentage $values.A.Value }} — swaps reverting."
      description = "Trading limit exceeded. Swaps on this token revert until the limit window rolls."
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
        expr    = "mento_pool_limit_pressure"
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
          evaluator = { params = [1.0], type = "gte" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_critical.contact_point
      group_by        = local.notify_critical.group_by
      group_wait      = local.notify_critical.group_wait
      group_interval  = local.notify_critical.group_interval
      repeat_interval = local.notify_critical.repeat_interval
    }
  }
}

# ── Rebalancer liveness ──────────────────────────────────────────────────────
resource "grafana_rule_group" "fpmms_rebalancer" {
  name             = "Rebalancer Liveness"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  rule {
    name           = "Rebalancer Stale"
    condition      = "threshold"
    for            = "5m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      description = "Deviation threshold has been breached for {{ humanizeDuration $values.A.Value }} and the rebalancer hasn't acted in more than 30 minutes. Likely stuck bot, insufficient gas, or contract-level failure."
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    # Fires only when: breach is active AND breach > 1h AND last rebalance > 30min ago.
    # Returns seconds-since-last-rebalance so the annotation is informative.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId = "A"
        # No `last_rebalanced_at > 0` guard on purpose: a pool that has
        # NEVER been rebalanced while sitting in an active breach is the
        # strongest case of "rebalancer never acted" — exactly the KPI 4
        # critical we want to page on. The `breach_start > 0` + `breach >
        # 1h` clauses already filter out healthy never-rebalanced pools,
        # so the raw `time() - 0` arithmetic can't false-fire on its own.
        expr = join(" and ", [
          "(time() - mento_pool_last_rebalanced_at)",
          "(mento_pool_deviation_breach_start > 0)",
          "((time() - mento_pool_deviation_breach_start) > 3600)",
          "((time() - mento_pool_last_rebalanced_at) > 1800)",
        ])
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
      contact_point   = local.notify_critical.contact_point
      group_by        = local.notify_critical.group_by
      group_wait      = local.notify_critical.group_wait
      group_interval  = local.notify_critical.group_interval
      repeat_interval = local.notify_critical.repeat_interval
    }
  }
}
