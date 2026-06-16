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
#
# DEVIATION THRESHOLDS — the bare `1.01` (warn) and `1.05` (critical) literals
# in this file plus the PromQL literals in main.tf mirror the TS canonical
# source at `shared-config/src/thresholds.ts` (`DEVIATION_TOLERANCE_RATIO` /
# `DEVIATION_CRITICAL_RATIO`). HCL can't import TS, so any threshold change is a
# coordinated edit across packages: bump the TS constants, then mirror them in
# Terraform. `scripts/check-deviation-threshold-drift.mjs` enforces that mirror.

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
      title            = "Oracle Update Delayed"
      summary          = "The pool oracle has not published a new price within its ${local.oracle_update_window_duration_annotation} update window."
      last_update      = "{{ if and $values.OracleAge (gt $values.OracleAge.Value 0.0) }}${local.oracle_live_age_duration_annotation} ago{{ else }}never reported{{ end }}"
      resolved_title   = "Oracle Update Recovered"
      resolved_summary = "The pool oracle is publishing recent prices again."
    }

    labels = {
      service  = "fpmms"
      severity = "warning"
    }

    # Liveness ratio `(now - last_report) / expiry` with FX weekend
    # suppression. Threshold raised from the spec's 0.8 → 1.2 to cut noise
    # from cleanly-recovering oracles. See main.tf for the gated expression.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = local.fx_gated_liveness_ratio_promql
        instant = true
      })
    }

    # Annotation helper queries:
    #   - OracleTs: live freshness timestamp. == 0 means the indexer has never
    #     seen a live median update for this pool.
    #   - OracleAge: seconds since live update; -1 when OracleTs <= 0 so the
    #     annotation helper keeps a label-matched fallback series.
    #   - OracleExpiry: the configured update window, displayed in the summary.
    data {
      ref_id         = "OracleTs"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleTs"
        expr    = local.oracle_live_timestamp_compat_promql
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
        expr    = local.oracle_live_age_compat_promql
        instant = true
      })
    }

    data {
      ref_id         = "OracleExpiry"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleExpiry"
        expr    = local.oracle_expiry_compat_promql
        instant = true
      })
    }

    dynamic "data" {
      for_each = merge(local.oracle_expiry_duration_part_promql, local.oracle_age_duration_part_promql)
      iterator = duration_part

      content {
        ref_id         = duration_part.key
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = duration_part.key
          expr    = duration_part.value
          instant = true
        })
      }
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
          evaluator = { params = [1.2], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_warning_oracles_pool.contact_point
      group_by        = local.notify_warning_oracles_pool.group_by
      group_wait      = local.notify_warning_oracles_pool.group_wait
      group_interval  = local.notify_warning_oracles_pool.group_interval
      repeat_interval = local.notify_warning_oracles_pool.repeat_interval
    }
  }

  # Three critical rules kept separate so Slack names the precise failure:
  #   - `Oracle Contract Down`: raw event-time contract flag, never FX-gated.
  #   - `Oracle Down`: live scrape-time usability bit (contract flag plus
  #     expiry freshness), suppressed only while an FX market pause is expected.
  #   - `Oracle Liveness Critical`: ratio > 3, using the same FX pause gate.
  rule {
    name           = "Oracle Contract Down"
    condition      = "threshold"
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary = "Oracle contract flag is false — swaps will revert.{{ if and $values.OracleAge (gt $values.OracleAge.Value 0.0) }} Last update: {{ humanizeDuration $values.OracleAge.Value }} ago.{{ else }} Oracle has never reported on this pool.{{ end }}"
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
        expr    = local.oracle_contract_down_active_promql
        instant = true
      })
    }

    data {
      ref_id         = "OracleTs"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleTs"
        expr    = local.oracle_timestamp_compat_promql
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
        expr    = local.oracle_timestamp_age_promql
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
      contact_point   = local.notify_critical_pool.contact_point
      group_by        = local.notify_critical_pool.group_by
      group_wait      = local.notify_critical_pool.group_wait
      group_interval  = local.notify_critical_pool.group_interval
      repeat_interval = local.notify_critical_pool.repeat_interval
    }
  }

  rule {
    name           = "Oracle Down"
    condition      = "threshold"
    for            = "5m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      title            = "Oracle Not Usable"
      summary          = "Oracle not usable — swaps will revert.{{ if and $values.OracleAge (gt $values.OracleAge.Value 0.0) }} Last live update: {{ humanizeDuration $values.OracleAge.Value }} ago.{{ else }} Oracle has never reported on this pool.{{ end }}"
      resolved_title   = "Oracle back up"
      resolved_summary = "Swaps should no longer revert."
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
        expr    = local.oracle_live_down_active_promql
        instant = true
      })
    }

    # See Oracle Liveness for the OracleTs / OracleAge rationale. Oracle Down
    # fires on the same live freshness anchor, so its Slack age text cannot
    # drift from the timestamp used by the live-down gate. OracleTs is kept as
    # a Grafana UI diagnostic; Slack copy branches on OracleAge.
    data {
      ref_id         = "OracleTs"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleTs"
        expr    = local.oracle_live_timestamp_compat_promql
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
        expr    = local.oracle_live_age_compat_promql
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
      contact_point   = local.notify_critical_pool.contact_point
      group_by        = local.notify_critical_pool.group_by
      group_wait      = local.notify_critical_pool.group_wait
      group_interval  = local.notify_critical_pool.group_interval
      repeat_interval = local.notify_critical_pool.repeat_interval
    }
  }

  rule {
    name           = "Oracle Liveness Critical"
    condition      = "threshold"
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    # Diagnostic retained out of Slack copy: if this fires while the live
    # Oracle Down rule stays quiet, check whether the indexer's oracleOk
    # derivation has drifted from the on-chain expiry check.
    annotations = {
      title            = "Oracle Down"
      summary          = "The pool oracle is far past its ${local.oracle_update_window_duration_annotation} update window."
      last_update      = "{{ if and $values.OracleAge (gt $values.OracleAge.Value 0.0) }}${local.oracle_live_age_duration_annotation} ago{{ else }}never reported{{ end }}"
      resolved_title   = "Oracle Back Up"
      resolved_summary = "The pool oracle is back inside its update window."
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    # Same gated ratio as the warning rule, fired at 3× so only badly-broken
    # oracles page the critical channel.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = local.fx_gated_liveness_ratio_promql
        instant = true
      })
    }

    # See Oracle Liveness for the annotation helper query rationale; OracleAge
    # is -1 for true never-reported pools instead of relying on a missing
    # annotation series.
    data {
      ref_id         = "OracleTs"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleTs"
        expr    = local.oracle_live_timestamp_compat_promql
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
        expr    = local.oracle_live_age_compat_promql
        instant = true
      })
    }

    data {
      ref_id         = "OracleExpiry"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "OracleExpiry"
        expr    = local.oracle_expiry_compat_promql
        instant = true
      })
    }

    dynamic "data" {
      for_each = merge(local.oracle_expiry_duration_part_promql, local.oracle_age_duration_part_promql)
      iterator = duration_part

      content {
        ref_id         = duration_part.key
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = duration_part.key
          expr    = duration_part.value
          instant = true
        })
      }
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
          evaluator = { params = [3.0], type = "gt" }
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

# ── Deviation breach ─────────────────────────────────────────────────────────
resource "grafana_rule_group" "fpmms_deviation" {
  name             = "Deviation Breach"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  # KPI 2 warn: above 1% tolerance, sustained for > 15 min. The 15m hold
  # smooths weekend flicker on FX pools (spec §3 was originally "≥ 1 for >
  # 15 min"; the tolerance dead zone replaces the 1.0 boundary).
  rule {
    name           = "Deviation Breach"
    condition      = "threshold"
    for            = "15m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary          = local.deviation_warning_summary_annotation
      resolved_title   = "Deviation Breach Alert Stopped"
      resolved_summary = local.deviation_resolved_summary_annotation
      current_reserves = local.deviation_current_reserves_annotation
      rebalance_reason = local.deviation_rebalance_reason_annotation
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
        expr    = local.deviation_warning_active_promql
        instant = true
      })
    }

    # BreachAge = active threshold-breach duration for the warning summary.
    # The threshold driver A stays as the ratio, so this annotation-only query
    # carries the duration without changing alert semantics.
    data {
      ref_id         = "BreachAge"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "BreachAge"
        expr    = "(time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0)"
        instant = true
      })
    }

    dynamic "data" {
      # Same annotation shape as critical by design. This adds a bounded set of
      # instant diagnostic queries to the warning eval so Slack can show reserves
      # and a likely rebalance-blocked reason when metrics-bridge has one.
      for_each = local.deviation_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
    }

    data {
      ref_id         = "Info"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Info"
        expr    = local.deviation_warning_resolved_info_promql
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
          evaluator = { params = [1.01], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_warning_pools_pool.contact_point
      group_by        = local.notify_warning_pools_pool.group_by
      group_wait      = local.notify_warning_pools_pool.group_wait
      group_interval  = local.notify_warning_pools_pool.group_interval
      repeat_interval = local.notify_warning_pools_pool.repeat_interval
    }
  }

  # Fallback warning for the window where the indexer has anchored a breach
  # (`deviationBreachStartedAt > 0`) but the bridge is NOT publishing
  # `mento_pool_deviation_ratio` — this happens whenever `lastDeviationRatio`
  # is the `-1` sentinel (see metrics-bridge/src/metrics.ts:110). The indexer
  # treats the anchor as the authoritative breach signal (see
  # indexer-envio/src/deviationBreach.ts comment at L98-107), so this rule
  # exists to keep warning coverage continuous while deviation-ratio data is
  # unavailable.
  rule {
    name           = "Deviation Breach (anchored)"
    condition      = "threshold"
    for            = "15m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary          = "Breach active for {{ humanizeDuration $values.A.Value }} — deviation-ratio data unavailable."
      resolved_title   = "Deviation Breach Alert Stopped"
      resolved_summary = local.deviation_resolved_summary_annotation
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
        expr    = local.deviation_warning_unavailable_active_promql
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

    data {
      ref_id         = "Info"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Info"
        expr    = local.deviation_warning_unavailable_resolved_info_promql
        instant = true
      })
    }

    notification_settings {
      contact_point   = local.notify_warning_pools_pool.contact_point
      group_by        = local.notify_warning_pools_pool.group_by
      group_wait      = local.notify_warning_pools_pool.group_wait
      group_interval  = local.notify_warning_pools_pool.group_interval
      repeat_interval = local.notify_warning_pools_pool.repeat_interval
    }
  }

  # `for = "1m"`: the threshold is already "breach age > 1h", so this does
  # NOT add a duration requirement to whether the breach itself counts as
  # critical. It just smooths transient NoData blips from the Mimir ruler:
  # after the 2026-04-28 incident where a missing series in the annotation
  # query set propagated NoData and reset alert state to Normal between
  # eval cycles (despite manual `/api/v1/eval` returning Alerting), a 1m
  # grace prevents single-eval glitches from undoing an otherwise stable
  # firing state. Same rationale on the anchored rule below.
  rule {
    name           = "Deviation Breach Critical"
    condition      = "threshold"
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary          = local.deviation_critical_summary_annotation
      resolved_title   = "Deviation Breach Alert Stopped"
      resolved_summary = local.deviation_resolved_summary_annotation
      # Pre-rendered "17% axlUSDC / 83% USDm". Reads pre-scaled
      # percentage values from R0/R1 and the per-series `token_symbol`
      # label written by metrics-bridge. No sprig — map access via
      # `.Labels.token_symbol` is a Go-template builtin.
      # When metrics-bridge can't resolve a contract address it falls
      # back to literal "token0" / "token1" (matches the existing `pair`
      # fallback semantics).
      current_reserves = local.deviation_current_reserves_annotation
      # Rebalance reason annotation, sourced from the metrics-bridge probe
      # (`mento_pool_rebalance_blocked`) for the bounded Solidity-error
      # reason and from Aegis (USDC/USDT/axlUSDC `_balanceOf`) for the
      # live reserve balance. The probe runs every Nth Hasura poll for
      # pools matching this rule's gate, so the rebalance_blocked label
      # set carries the same `chain_id`/`pool_id`/`pair` identity as the
      # alert. Rendered in the Slack body via
      # `{{ if .Annotations.rebalance_reason }}` — see contact-points.tf.
      # When the probe hasn't run yet or the RPC failed, the rebalance_
      # blocked gauge is absent and this annotation expands to empty
      # string, which the template suppresses.
      #
      # `$labels` in a Grafana alert annotation only exposes labels from
      # the firing series (query A — the breach gauge). Query B's labels
      # (`reason_code` / `reason_message`) live on its own series and are
      # accessible via `$values.B.Labels.*`. The Aegis reserve-balance
      # queries return ALL series (Aegis label set differs from
      # `mento_pool_*`, so per-instance binding doesn't apply); the
      # template dispatches by `$labels.pair`.
      rebalance_reason = local.deviation_rebalance_reason_annotation
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    # The Prometheus expression: seconds since breach started, gated on an
    # active breach (breach_start > 0), current magnitude still above the
    # 1.01 warning tolerance, and either current OR open-breach peak
    # magnitude above 1.05 (5% over threshold). Once an open breach crosses
    # critical it stays with the critical rule until recovered, so warning
    # notification suppression cannot create a silent de-escalation gap.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = local.deviation_critical_gate_promql
        instant = true
      })
    }

    # Annotation-only queries (Dev / R0 / R1 / B / ResUSDC / ResUSDT /
    # ResAxlUSDC) — populate `$values.*` for the annotation locals in
    # main.tf. NOT part of the threshold condition: a missing series for
    # any one of these (e.g. probe hasn't run yet, ratio sentinel, both
    # reserves zero, non-stable pool with no Aegis coverage) leaves
    # `$values.X` empty and the `{{ if }}` guards in each annotation drop
    # the line cleanly. Authored once in
    # `local.deviation_annotation_queries` and consumed here +
    # by the anchored rule below — a query-shape change lands in one place.
    #
    # Implementation notes:
    #   - Dev pre-computes `(ratio - 1) * 100` in PromQL because sprig math
    #     (`sub`/`mul`) is unavailable in Grafana annotation templates.
    #     Integer percent + `printf "%.0f%%"` keeps a 122x breach out of
    #     scientific notation (humanizePercentage's `%.4g` would render
    #     "1.219e+04% above threshold").
    #   - R0/R1 scale the FLAT reserve-share gauges by 100 for display
    #     (labels preserved, no `token_index` label) so the per-instance
    #     match against query A's `pool_id/chain_id/pair` fingerprint binds.
    #     A previous version with `token_index` silently dropped
    #     `$values.R0` / `$values.R1`. The `token_symbol` extension is 1:1
    #     with `pool_id` so it doesn't widen cardinality. Regression-tested
    #     in `metrics-bridge/test/metrics.test.ts` ("label-shape contract").
    #   - B = `mento_pool_rebalance_blocked > 0` so the series is empty
    #     when the probe couldn't determine a reason; the annotation
    #     template reads `$values.B.Labels.*` (NOT `$labels`, which exposes
    #     only the condition query A's labels).
    #   - ResUSDC / ResUSDT / ResAxlUSDC source from Aegis (Celo only); see
    #     main.tf for the rationale on why the dispatch happens in the
    #     `rebalance_reason` template instead of via per-instance label match.
    dynamic "data" {
      for_each = local.deviation_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
    }

    data {
      ref_id         = "Info"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Info"
        expr    = local.deviation_critical_resolved_info_promql
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
      contact_point   = local.notify_critical_pool.contact_point
      group_by        = local.notify_critical_pool.group_by
      group_wait      = local.notify_critical_pool.group_wait
      group_interval  = local.notify_critical_pool.group_interval
      repeat_interval = local.notify_critical_pool.repeat_interval
    }
  }

  # Critical fallback for the deviation-ratio-unavailable window where the indexer
  # has anchored a breach for >1h but the bridge isn't publishing
  # `mento_pool_deviation_ratio` (the `-1` sentinel from metrics-bridge).
  # Without this rule, the magnitude-gated critical above silently drops
  # alerts while deviation-ratio data is unavailable —
  # the anchored warning rule still fires, but at warning severity. Mirror of
  # the warning anchored rule, escalated to critical once the breach has
  # outlived the 1h grace.
  rule {
    name      = "Deviation Breach Critical (anchored)"
    condition = "threshold"
    # `for = "1m"`: same NoData-blip smoothing as the magnitude-gated rule
    # above. The anchored rule fires only when the deviation-ratio gauge
    # is absent, so the annotation query set is even sparser — without
    # the 1m grace a single Mimir-ruler glitch in either Aegis reserve-
    # balance query would reset the firing state.
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary          = "Breach active for {{ humanizeDuration $values.A.Value }} — deviation-ratio data unavailable; can't confirm magnitude."
      resolved_title   = "Deviation Breach Alert Stopped"
      resolved_summary = local.deviation_resolved_summary_annotation
      # Reserve share is independent of the deviation ratio gauge — even
      # when the ratio is in its `-1` sentinel state, the indexer is still
      # writing reserves on every Swap / ReserveUpdate, so this line
      # typically renders. See the magnitude-gated rule for the display
      # formatting rationale.
      current_reserves = local.deviation_current_reserves_annotation
      # Same rebalance-reason annotation as the magnitude-gated critical
      # rule. The metrics-bridge probe gates on `lastDeviationRatio > 1.05`
      # (which is the `-1` sentinel while deviation-ratio data is unavailable,
      # so eligible pools in this state typically slip past) — but if a probe
      # DID run before the deviation-ratio gauge dropped, the most-recent
      # reason annotation would still be present here. Reads
      # `$values.B.Labels.*` for the bounded
      # reason label pair (NOT `$labels`, which exposes only the firing
      # query's labels), and dispatches to the matching Aegis reserve-balance
      # series via `$labels.pair`. When neither the reason labels nor the
      # Aegis series are present, the `{{ if … }}` guards collapse the
      # annotation cleanly.
      rebalance_reason = local.deviation_rebalance_reason_annotation
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
        expr    = local.deviation_critical_unavailable_active_promql
        instant = true
      })
    }

    # Annotation-only queries (Dev / R0 / R1 / B / ResUSDC / ResUSDT /
    # ResAxlUSDC) — see the magnitude-gated rule above for the rationale
    # on each query and why they sit outside the threshold condition.
    # Authored once in `local.deviation_annotation_queries` so
    # the magnitude-gated and anchored rules can never drift in shape.
    dynamic "data" {
      for_each = local.deviation_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
    }

    data {
      ref_id         = "Info"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Info"
        expr    = local.deviation_critical_unavailable_resolved_info_promql
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
      contact_point   = local.notify_critical_pool.contact_point
      group_by        = local.notify_critical_pool.group_by
      group_wait      = local.notify_critical_pool.group_wait
      group_interval  = local.notify_critical_pool.group_interval
      repeat_interval = local.notify_critical_pool.repeat_interval
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
      contact_point   = local.notify_warning_pools_pool.contact_point
      group_by        = local.notify_warning_pools_pool.group_by
      group_wait      = local.notify_warning_pools_pool.group_wait
      group_interval  = local.notify_warning_pools_pool.group_interval
      repeat_interval = local.notify_warning_pools_pool.repeat_interval
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
      contact_point   = local.notify_critical_pool.contact_point
      group_by        = local.notify_critical_pool.group_by
      group_wait      = local.notify_critical_pool.group_wait
      group_interval  = local.notify_critical_pool.group_interval
      repeat_interval = local.notify_critical_pool.repeat_interval
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
      summary          = "Rebalancer hasn't acted{{ if $values.BreachAge }} despite {{ humanizeDuration $values.BreachAge.Value }} of ongoing threshold breach{{ else }} despite ongoing threshold breach{{ end }}."
      resolved_title   = "Rebalancer healthy again"
      resolved_summary = "The pool was rebalanced or the breach cleared."
      last_rebalance   = "{{ if and $values.A $values.LastRebalancedAt (gt $values.LastRebalancedAt.Value 0.0) }}{{ humanizeDuration $values.A.Value }} ago{{ else if and $values.LastRebalancedAt (eq $values.LastRebalancedAt.Value 0.0) }}Never{{ end }}"
      root_cause       = local.deviation_rebalance_reason_annotation
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
        expr = format(
          "%s unless (%s)",
          join(" and ", [
            "(time() - mento_pool_last_rebalanced_at)",
            "(mento_pool_deviation_breach_start > 0)",
            "((time() - mento_pool_deviation_breach_start) > 3600)",
            "((time() - mento_pool_last_rebalanced_at) > 1800)",
          ]),
          local.fx_rebalancer_stale_suppressed_breach_start_promql,
        )
        instant = true
      })
    }

    # BreachAge = active threshold-breach duration. This is separate from A
    # because A is seconds since last rebalance; the Slack summary should tell
    # operators how long the pool has been in the threshold-breach state, while
    # the Last Rebalance row keeps the idle age.
    data {
      ref_id         = "BreachAge"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "BreachAge"
        expr    = "(time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0)"
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

    dynamic "data" {
      for_each = local.deviation_rebalancer_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
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
      contact_point   = local.notify_critical_pool.contact_point
      group_by        = local.notify_critical_pool.group_by
      group_wait      = local.notify_critical_pool.group_wait
      group_interval  = local.notify_critical_pool.group_interval
      repeat_interval = local.notify_critical_pool.repeat_interval
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
      summary          = "Last rebalance effectiveness only {{ if $values.EffPct }}{{ printf \"%.1f%%\" $values.EffPct.Value }}{{ else }}{{ printf \"%.2f\" $values.A.Value }}{{ end }} — not closing the deviation breach."
      description      = "Most recent in-breach rebalance closed less than 50% of the gap to the rebalance boundary AND no better rebalance has landed in the past 15 min. Effectiveness is measured against the boundary (`rebalanceThreshold`), not the oracle midpoint — 100% means the rebalance landed exactly on the boundary (ideal); values > 100% = overshoot; < 100% = under-correction."
      resolved_title   = "Rebalance effective again"
      resolved_summary = "Rebalance effectiveness recovered or the deviation breach cleared."
      root_cause       = local.deviation_rebalance_reason_annotation
    }

    labels = {
      service  = "fpmms"
      severity = "warning"
    }

    # A = effectiveness ratio of the MOST RECENT rebalance, gated to pools that
    # are:
    #   1. in an ACTIVE breach — use `deviation_breach_start > 0` (the indexer's
    #      authoritative breach anchor, set when devRatio crosses strictly above
    #      the 1% tolerance line). Intentionally NOT `deviation_ratio >= 1` or
    #      `> 1.01`: the anchor encodes both the strict-`>` semantics and the
    #      tolerance threshold in one signal, and stays consistent while
    #      deviation-ratio data is unavailable.
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
        expr = format(
          "%s unless (%s)",
          join(" and ", [
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
          ]),
          local.fx_weekend_suppressed_breach_start_promql,
        )
        instant = true
      })
    }

    # Fires when the most recent in-breach rebalance closed less than half
    # the gap to the boundary — the spec's "repeated low-effect rebalance"
    # signal (§3, KPI 4). Revisit threshold once production data lands.
    data {
      ref_id         = "EffPct"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId = "EffPct"
        expr = format(
          "%s unless (%s)",
          join(" and ", [
            "last_over_time(mento_pool_rebalance_effectiveness[1h]) * 100",
            "(mento_pool_deviation_breach_start > 0)",
            "(mento_pool_last_rebalanced_at >= mento_pool_deviation_breach_start)",
            "((time() - mento_pool_last_rebalanced_at) < 3600)",
          ]),
          local.fx_weekend_suppressed_breach_start_promql,
        )
        instant = true
      })
    }

    dynamic "data" {
      for_each = local.deviation_rebalancer_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
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
      contact_point   = local.notify_warning_pools_pool.contact_point
      group_by        = local.notify_warning_pools_pool.group_by
      group_wait      = local.notify_warning_pools_pool.group_wait
      group_interval  = local.notify_warning_pools_pool.group_interval
      repeat_interval = local.notify_warning_pools_pool.repeat_interval
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
#   2. `mento_pool_swap_fee_bps >= 0` — the metrics-bridge `-1` sentinel is
#      never published, so every series present at alert-eval time
#      corresponds to a pool with a real fee. A published 0 is a legitimate
#      zero-fee pool and must remain eligible to alert.
#
# Not FX-weekend gated. A large FX jump on Monday open IS exactly the
# LP-leakage event the alert is designed to catch; suppressing it would
# hide the most expensive arbitrage window of the week. The existing
# `Oracle Contract Down` critical rule is un-suppressed for the same reason.
resource "grafana_rule_group" "fpmms_oracle_jump" {
  name             = "Oracle Price Jump"
  folder_uid       = grafana_folder.fpmms.uid
  interval_seconds = 60

  rule {
    name      = "Oracle Jump Exceeds Swap Fee"
    condition = "threshold"
    # `for = "1m"` smooths transient NoData blips from the Mimir ruler. The
    # threshold is "any in-band jump within the last 10m", so this does NOT
    # add a meaningful duration requirement — same rationale as the
    # `Deviation Breach Critical` rule (see the 2026-04-28 incident note
    # above). A single-eval glitch in any annotation query would otherwise
    # reset alert state to Normal between eval cycles.
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    # `JumpPct` / `FeePct` divide bps by 100 in PromQL so the summary can
    # render the same `%.4g %%` format as the critical rule. Sprig math is
    # NOT in scope for Grafana annotation templates (see the deviation-
    # breach `Dev` query for the canonical rationale), so the math has to
    # live in the query.
    #
    # Both `JumpPct` and `FeePct` are nil-guarded with a `?` fallback. The
    # bridge gates `mento_pool_swap_fee_bps` on the `-1` sentinel and
    # `mento_pool_oracle_jump_bps` on series presence — either could be
    # absent for a single eval cycle (bridge restart, Hasura blip), which
    # would nil-panic an unguarded `printf $values.X.Value`.
    annotations = {
      summary     = "Oracle price jumped {{ if $values.JumpPct }}{{ printf \"%.4g\" $values.JumpPct.Value }}{{ else }}?{{ end }}% — above the pool's {{ if $values.FeePct }}{{ printf \"%.4g\" $values.FeePct.Value }}{{ else }}?{{ end }}% swap fee. LPs leaking per arb round-trip."
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
          # rule takes over. Written as `jump * 10 < fee * 11` instead of
          # `jump < fee * 1.10` because `fee * 11` is integer-exact — the
          # direct `* 1.10` form has IEEE-754 residue for fees that aren't
          # multiples of 10, which can misroute an exact-boundary jump to
          # the wrong severity (e.g. on a 3 bps fee a 3.3 bps jump would
          # otherwise fall in the warning band).
          "(mento_pool_oracle_jump_bps * 10 < mento_pool_swap_fee_bps * 11)",
          "((time() - mento_pool_oracle_jump_at) < 600)",
          # `>= 0` not `> 0`: the metrics-bridge `-1` sentinel is never
          # published, so a zero here is always a legitimately zero-fee
          # pool that should still alert on any jump.
          "(mento_pool_swap_fee_bps >= 0)",
        ])
        instant = true
      })
    }

    # JumpPct / FeePct — annotation-only, pre-rendered in PromQL because
    # sprig math isn't available in Grafana annotation templates. Same
    # pattern as the critical rule (see `oracle_jump_critical_annotation_queries`
    # in main.tf — kept inline here because the warning needs only the
    # pct pair, not the price/age set).
    dynamic "data" {
      for_each = local.oracle_jump_warning_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
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
      contact_point   = local.notify_warning_oracles_pool.contact_point
      group_by        = local.notify_warning_oracles_pool.group_by
      group_wait      = local.notify_warning_oracles_pool.group_wait
      group_interval  = local.notify_warning_oracles_pool.group_interval
      repeat_interval = local.notify_warning_oracles_pool.repeat_interval
    }
  }

  rule {
    name      = "Oracle Jump Far Above Swap Fee"
    condition = "threshold"
    # `for = "1m"` smooths transient NoData blips from the Mimir ruler —
    # same rationale as the warning tier and the deviation-breach critical
    # rule (see the 2026-04-28 incident note earlier in this file). Without
    # it, a single-eval glitch on any annotation-only query (e.g. the new
    # oracle-price gauges during a bridge restart) would propagate NoData
    # and reset alert state to Normal between cycles.
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    # `JumpPct` / `FeePct` divide bps by 100 in PromQL because sprig math
    # (`mul`/`div`) is NOT in scope for Grafana annotation templates — same
    # rationale that pre-renders `Dev` for the deviation-breach alert. The
    # `%.4g` format keeps trailing zeros off both whole-number fees ("0.1"
    # not "0.1000") and sub-bps jumps ("0.1727" not "0.17270").
    #
    # `current_oracle_price` / `previous_oracle_price` source from the
    # bridge's `mento_pool_oracle_price` and `_prev_price` gauges. Both skip
    # the 0 sentinel, so the `{{ if … }}` guards collapse the annotation
    # cleanly when the indexer hasn't seen a second non-zero MedianUpdated
    # yet — matches the pattern used by `current_reserves` for one-sided
    # pools.
    #
    # `AgeNow` reuses `mento_pool_oracle_jump_at` rather than a separate
    # `oracle_price_at` series — at alert-fire time both equal `lastMedianAt`
    # (the handler updates them together when `jumpBps != null`). Skipping
    # the extra metric keeps cardinality flat without losing fidelity.
    annotations = {
      summary               = "Oracle price jumped {{ if $values.JumpPct }}{{ printf \"%.4g\" $values.JumpPct.Value }}{{ else }}?{{ end }}% — significantly above the pool's {{ if $values.FeePct }}{{ printf \"%.4g\" $values.FeePct.Value }}{{ else }}?{{ end }}% swap fee. LPs are at risk."
      description           = "Most recent MedianUpdated delta is at least 10% above the pool's combined swap fee. Arbitrageurs can round-trip through the pool faster than rebalancing can catch, and the leakage compounds with volume. Investigate the oracle feed and the rebalancer's next-cycle response."
      current_oracle_price  = "{{ if and $values.OraclePrice $values.AgeNow }}{{ printf \"%.4g\" $values.OraclePrice.Value }} ({{ humanizeDuration $values.AgeNow.Value }} ago){{ end }}"
      previous_oracle_price = "{{ if and $values.OraclePrev $values.PrevAge }}{{ printf \"%.4g\" $values.OraclePrev.Value }} ({{ humanizeDuration $values.PrevAge.Value }} ago){{ end }}"
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    # Boundary: `>=` sends an exact 10%-above (e.g. 11 bps on a 10 bps fee)
    # to critical, matching the user-stated cutoff. The warning rule's
    # strict `<` upper bound preserves mutual exclusion. See the warning
    # rule for why the boundary is expressed as `jump * 10 ⋈ fee * 11`
    # rather than `jump ⋈ fee * 1.10`.
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
          "(mento_pool_oracle_jump_bps * 10 >= mento_pool_swap_fee_bps * 11)",
          "((time() - mento_pool_oracle_jump_at) < 600)",
          "(mento_pool_swap_fee_bps >= 0)",
        ])
        instant = true
      })
    }

    # Annotation-only queries — populate `$values.*` for the templates above.
    # NOT part of the threshold condition: a missing series for any one of
    # these (e.g. indexer hasn't seen a second median yet, bridge restart
    # mid-eval) leaves `$values.X` empty and the `{{ if }}` guards drop the
    # corresponding line. JumpPct / FeePct are derived (bps → %) in PromQL
    # because sprig math is unavailable in annotation templates.
    dynamic "data" {
      for_each = local.oracle_jump_critical_annotation_queries
      content {
        ref_id         = data.value.ref_id
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = local.instant_query_range_seconds
          to   = 0
        }
        model = jsonencode({
          refId   = data.value.ref_id
          expr    = data.value.expr
          instant = true
        })
      }
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
