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
      summary = "Live-ratio {{ printf \"%.2f\" $values.A.Value }} — oracle report overdue.{{ if and $values.OracleTs (gt $values.OracleTs.Value 0.0) }} Last update: {{ humanizeDuration $values.OracleAge.Value }} ago.{{ else }} Oracle has never reported on this pool.{{ end }}"
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

    # Two queries, used together by the annotation template:
    #   - OracleTs: raw timestamp. == 0 means the indexer never received a
    #     report for this pool (default sentinel, see
    #     indexer-envio/src/pool.ts:212+). The template branches on this
    #     to render "Oracle has never reported" — keying off the explicit
    #     zero, not an age heuristic, so legitimately stale-for-years
    #     pools still render their actual age.
    #   - OracleAge: seconds-since-report; only meaningful when OracleTs > 0.
    data {
      ref_id         = "OracleTs"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleTs"
        expr    = "mento_pool_oracle_timestamp"
        instant = true
      })
    }

    data {
      ref_id         = "OracleAge"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleAge"
        expr    = "time() - mento_pool_oracle_timestamp"
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
      summary = "Oracle not usable — swaps will revert.{{ if and $values.OracleTs (gt $values.OracleTs.Value 0.0) }} Last update: {{ humanizeDuration $values.OracleAge.Value }} ago.{{ else }} Oracle has never reported on this pool.{{ end }}"
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

    # See Oracle Liveness for the OracleTs / OracleAge rationale — same
    # pair is used here so the annotation can detect the never-reported
    # sentinel (oracle_timestamp == 0) instead of leaning on an age cutoff.
    data {
      ref_id         = "OracleTs"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleTs"
        expr    = "mento_pool_oracle_timestamp"
        instant = true
      })
    }

    data {
      ref_id         = "OracleAge"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleAge"
        expr    = "time() - mento_pool_oracle_timestamp"
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
      summary     = "Liveness {{ printf \"%.2f\" $values.A.Value }} ≥ 1 — last report past expiry.{{ if and $values.OracleTs (gt $values.OracleTs.Value 0.0) }} Last update: {{ humanizeDuration $values.OracleAge.Value }} ago.{{ else }} Oracle has never reported on this pool.{{ end }}"
      description = "If this fires while Oracle Down stays quiet, the indexer's oracleOk derivation has drifted from the on-chain expiry check."
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

    # See Oracle Liveness for the OracleTs / OracleAge rationale — same
    # pair is used here so the annotation can detect the never-reported
    # sentinel (oracle_timestamp == 0) instead of leaning on an age cutoff.
    data {
      ref_id         = "OracleTs"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleTs"
        expr    = "mento_pool_oracle_timestamp"
        instant = true
      })
    }

    data {
      ref_id         = "OracleAge"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleAge"
        expr    = "time() - mento_pool_oracle_timestamp"
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
      summary = "Deviation ratio {{ printf \"%.2f\" $values.A.Value }} — pool out of rebalance band."
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
      summary = "Breach active for {{ humanizeDuration $values.A.Value }} — ratio gauge missing."
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
      summary     = "Deviating for {{ humanizeDuration $values.A.Value }} — rebalancer not closing breach."
      description = "Check rebalancer liveness and oracle feed."
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
      summary = "token{{ $labels.token_index }} limit at {{ humanizePercentage $values.A.Value }} — trip imminent."
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
      description = "Window rolls on L0 (5m), L1 (24h), LG (lifetime). Check if counter-trades are expected."
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
      summary     = "{{ if and $values.LastRebalancedAt (gt $values.LastRebalancedAt.Value 0.0) }}Idle {{ humanizeDuration $values.A.Value }}{{ else }}Never rebalanced{{ end }} during {{ humanizeDuration $values.BreachAge.Value }} breach — rebalancer not acting."
      description = "Likely stuck bot, insufficient gas, or contract-level failure."
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    # A = seconds since last rebalance, filtered to only the pools where all
    # four fire conditions hold (breach active, breach > 1h, idle > 30m).
    # This is the threshold driver — `gt 0` means "any series returned".
    #
    # No `last_rebalanced_at > 0` guard on purpose: a pool that has NEVER
    # been rebalanced while sitting in an active breach is the strongest
    # case of "rebalancer never acted" — exactly the KPI 4 critical we
    # want to page on. The `breach_start > 0` + `breach > 1h` clauses
    # already filter out healthy never-rebalanced pools, so the raw
    # `time() - 0` arithmetic can't false-fire on its own.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId = "A"
        expr = join(" and ", [
          "(time() - mento_pool_last_rebalanced_at)",
          "(mento_pool_deviation_breach_start > 0)",
          "((time() - mento_pool_deviation_breach_start) > 3600)",
          "((time() - mento_pool_last_rebalanced_at) > 1800)",
        ])
        instant = true
      })
    }

    # LastRebalancedAt = raw timestamp; the annotation template uses it to
    # detect the never-rebalanced sentinel (== 0) and render "Never
    # rebalanced" instead of humanizing the bogus age. Keying off the
    # explicit 0 (not an age heuristic) keeps the copy correct for pools
    # that were rebalanced once long ago and then went dormant.
    data {
      ref_id         = "LastRebalancedAt"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "LastRebalancedAt"
        expr    = "mento_pool_last_rebalanced_at"
        instant = true
      })
    }

    # BreachAge = seconds since breach started. Used in the annotation —
    # "breached for X" reports *breach* duration, not idle duration (those
    # can differ: a breach might be 2h old while the rebalancer tried
    # 45m ago).
    data {
      ref_id         = "BreachAge"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "BreachAge"
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

  # KPI 4 effectiveness half: rebalancer is ALIVE (so `Rebalancer Stale` stays
  # quiet) but INEFFECTIVE. Without this rule, operators only learn about
  # control-loop failure when `Deviation Breach Critical` fires at 60 min, with
  # no visibility into why the rebalancer's corrections aren't landing.
  rule {
    name           = "Rebalance Ineffective"
    condition      = "threshold"
    for            = "15m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Latest rebalance effectiveness {{ printf \"%.2f\" $values.A.Value }} — control loop underperforming while still in breach."
      description = "Most recent in-breach rebalance closed less than 20% of the deviation AND no better rebalance has landed in the past 15 min. Likely stale-oracle race, MEV truncation, or sizing bug. Liveness OK — this is the effectiveness half of KPI 4."
    }

    labels = {
      service  = "fpmms"
      severity = "warning"
    }

    # A = effectiveness ratio of the MOST RECENT rebalance, gated to pools that
    # are:
    #   1. in an ACTIVE breach — use `deviation_breach_start > 0` (the indexer's
    #      authoritative breach anchor). Intentionally NOT `deviation_ratio >= 1`:
    #      the indexer uses strict `>` for breach detection (pool.ts:79 —
    #      exactly 1.0 stays OK), so `>= 1` is semantically wrong.
    #   2. rebalanced DURING the current breach — `last_rebalanced_at >=
    #      deviation_breach_start` ensures the ineffectiveness we're measuring
    #      actually belongs to this breach, not a prior one. `>=` (not `>`)
    #      admits the same-block case where a failed rebalance tips the pool
    #      into breach — see the inline note on the expression itself.
    #   3. rebalanced recently (< 1h ago) — the bridge re-publishes the
    #      effectiveness gauge every 30s, so a months-old value would otherwise
    #      keep `last_over_time` alive forever. The time-window gate caps staleness.
    #
    # Why `last_over_time` and not `avg_over_time`: the gauge is
    # last-write-wins (republished each bridge poll), so an avg over [1h] would
    # include samples from rebalances that happened BEFORE the current breach
    # started — a bad rebalance 45 min ago in the previous breach would
    # contaminate the average in the first 15 min of the new breach and could
    # false-fire this warning even when the current breach's rebalance was
    # effective. `last_over_time` reads only the most recent value, so the
    # breach-ownership gate (#2) fully controls which rebalance the alert
    # evaluates. The `for = 15m` still provides "sustained" semantics: a
    # subsequent better rebalance flips the value and clears the alert before
    # `for` expires; if no better rebalance lands in 15 min the rebalancer has
    # effectively given up, which IS the KPI 4 failure case.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId = "A"
        expr = join(" and ", [
          "last_over_time(mento_pool_rebalance_effectiveness[1h])",
          "(mento_pool_deviation_breach_start > 0)",
          # `>=` not `>`: both timestamps are block-second granularity written
          # from the same `blockTimestamp`, so a same-block event where a failed
          # rebalance tips the pool into breach produces
          # `last_rebalanced_at == deviation_breach_start` — exactly the KPI 4
          # control-loop-failure case the alert must catch. Strict `>` silently
          # dropped it.
          "(mento_pool_last_rebalanced_at >= mento_pool_deviation_breach_start)",
          "((time() - mento_pool_last_rebalanced_at) < 3600)",
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
          evaluator = { params = [0.2], type = "lt" }
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
}

# ── Oracle price jump vs. swap fee ───────────────────────────────────────────
#
# When the oracle posts a new median that moves by more than the pool's swap
# fee (lpFee + protocolFee), arbitrageurs can round-trip through the pool and
# extract the excess as LP losses. The two tiers split on magnitude:
#
#   warning  — swap_fee < jump < swap_fee × 1.10   (up to 10% over the fee)
#   critical — jump ≥ swap_fee × 1.10              (10%+ over the fee)
#
# Boundaries mirror the user-stated example: on a 10 bps fee, 10.5 bps fires
# warning; 11 bps fires critical. Mutually exclusive — a single jump matches
# exactly one rule.
#
# Common gates (applied via the same `and` chain as other KPI rules):
#   1. `(time() - mento_pool_oracle_jump_at) < 600` — only fire within 10 min
#      of the MedianUpdated event that produced the jump. Grafana eval is
#      every 60s and the gauge is last-write-wins, so without this gate a
#      single big jump would stay firing until the next median, which for a
#      quiet feed can be hours. The 10-min window aligns with the 600s
#      `instant_query_range_seconds` window already used repo-wide.
#   2. `mento_pool_swap_fee_bps > 0` — skip pools whose initial fee RPC
#      failed (metrics-bridge already drops the -1 sentinel, but a
#      belt-and-suspenders gate here keeps the PromQL self-contained).
#
# Not FX-weekend gated. A large FX jump on Monday open IS exactly the
# LP-leakage event the alert is designed to catch; suppressing it would
# hide the most expensive arbitrage window of the week. The existing
# `Oracle Down` critical rule is un-suppressed for the same reason.
resource "grafana_rule_group" "fpmms_oracle_jump" {
  name             = "Oracle Price Jump"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  rule {
    name           = "Oracle Jump Exceeds Swap Fee"
    condition      = "threshold"
    for            = "0m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Oracle jumped {{ printf \"%.2f\" $values.A.Value }} bps — above the pool's {{ printf \"%.0f\" $values.Fee.Value }} bps swap fee. LPs leaking per arb round-trip."
      description = "Most recent MedianUpdated delta is above the pool's combined swap fee but still within 10% of it. Warning tier — a single large move isn't pageable, but repeated occurrences point to an oracle or sizing tune-up."
    }

    labels = {
      service  = "fpmms"
      severity = "warning"
    }

    # A = current jump bps filtered to the warning band.
    # The `and` chain embeds the full alert condition; the threshold check
    # below just confirms A is non-empty (value > 0). Matches the same
    # pattern as `Rebalance Ineffective`.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId = "A"
        expr = join(" and ", [
          "mento_pool_oracle_jump_bps",
          "(mento_pool_oracle_jump_bps > mento_pool_swap_fee_bps)",
          # Strict `<` upper bound: at exactly swap_fee × 1.10 the critical
          # rule takes over. Keeping this bound in the warning expression
          # (instead of deferring to critical-wins-on-overlap) means both
          # severities can safely route to different channels.
          "(mento_pool_oracle_jump_bps < mento_pool_swap_fee_bps * 1.10)",
          "((time() - mento_pool_oracle_jump_at) < 600)",
          "(mento_pool_swap_fee_bps > 0)",
        ])
        instant = true
      })
    }

    # Fee sample — used by the summary annotation, not by the threshold.
    data {
      ref_id         = "Fee"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Fee"
        expr    = "mento_pool_swap_fee_bps"
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
    name           = "Oracle Jump Far Above Swap Fee"
    condition      = "threshold"
    for            = "0m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Oracle jumped {{ printf \"%.2f\" $values.A.Value }} bps — ≥10% above the pool's {{ printf \"%.0f\" $values.Fee.Value }} bps swap fee. LPs leaking per arb round-trip."
      description = "Most recent MedianUpdated delta is at least 10% above the pool's combined swap fee. Arbitrageurs can round-trip through the pool faster than rebalancing can catch, and the leakage compounds with volume. Investigate the oracle feed (stuck reporter, bridge-delay reopen, reporter disagreement) and the rebalancer's next-cycle response."
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    # Boundary: `>=` sends an exact 10%-above (e.g. 11 bps on a 10 bps fee)
    # to critical, matching the user-stated cutoff. The warning rule's
    # strict `<` upper bound preserves mutual exclusion.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId = "A"
        expr = join(" and ", [
          "mento_pool_oracle_jump_bps",
          "(mento_pool_oracle_jump_bps >= mento_pool_swap_fee_bps * 1.10)",
          "((time() - mento_pool_oracle_jump_at) < 600)",
          "(mento_pool_swap_fee_bps > 0)",
        ])
        instant = true
      })
    }

    data {
      ref_id         = "Fee"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Fee"
        expr    = "mento_pool_swap_fee_bps"
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
