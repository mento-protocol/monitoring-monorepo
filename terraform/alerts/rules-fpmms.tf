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
# below mirror the TS canonical source at `shared-config/src/thresholds.ts`
# (`DEVIATION_TOLERANCE_RATIO` / `DEVIATION_CRITICAL_RATIO`). HCL can't import
# TS, so any threshold change is a coordinated edit across packages: bump the
# TS constants, then mirror them here. The dashboard, metrics-bridge probe,
# and the indexer's bigint num/den pairs all derive from the same canonical
# values.

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
      summary = "Live-ratio {{ printf \"%.2f\" $values.A.Value }} — oracle report overdue (> 1.2× expiry).{{ if and $values.OracleTs (gt $values.OracleTs.Value 0.0) }} Last update: {{ humanizeDuration $values.OracleAge.Value }} ago.{{ else }} Oracle has never reported on this pool.{{ end }}"
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
          evaluator = { params = [1.2], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_warning_pool.contact_point
      group_by        = local.notify_warning_pool.group_by
      group_wait      = local.notify_warning_pool.group_wait
      group_interval  = local.notify_warning_pool.group_interval
      repeat_interval = local.notify_warning_pool.repeat_interval
    }
  }

  # Two critical rules kept separate so Slack names the precise failure:
  #   - `Oracle Down`: contract can-trade flag; stays 24/7 un-gated because a
  #     broken FX feed (vs. merely paused) must still page on weekends.
  #   - `Oracle Liveness Critical`: ratio > 3; FX-weekend gated like the
  #     warning, since a paused FX oracle sails past 3× within hours.
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

    annotations = {
      summary     = "Liveness {{ printf \"%.2f\" $values.A.Value }} > 3 — report badly stale.{{ if and $values.OracleTs (gt $values.OracleTs.Value 0.0) }} Last update: {{ humanizeDuration $values.OracleAge.Value }} ago.{{ else }} Oracle has never reported on this pool.{{ end }}"
      description = "Liveness ratio exceeds 3× the contract expiry. If Oracle Down stays quiet while this fires, the indexer's oracleOk derivation has drifted from the on-chain expiry check."
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
      summary = "Deviation ratio {{ printf \"%.2f\" $values.A.Value }} — pool above 1% tolerance."
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
          evaluator = { params = [1.01], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["threshold"] }
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    notification_settings {
      contact_point   = local.notify_warning_pool.contact_point
      group_by        = local.notify_warning_pool.group_by
      group_wait      = local.notify_warning_pool.group_wait
      group_interval  = local.notify_warning_pool.group_interval
      repeat_interval = local.notify_warning_pool.repeat_interval
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
      contact_point   = local.notify_warning_pool.contact_point
      group_by        = local.notify_warning_pool.group_by
      group_wait      = local.notify_warning_pool.group_wait
      group_interval  = local.notify_warning_pool.group_interval
      repeat_interval = local.notify_warning_pool.repeat_interval
    }
  }

  rule {
    name           = "Deviation Breach Critical"
    condition      = "threshold"
    for            = "0s"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Pool above 5% threshold for {{ humanizeDuration $values.A.Value }} — rebalancer not closing breach."
      description = "Check rebalancer liveness and oracle feed."
      # Pre-rendered "8% above threshold". `Dev` query pre-computes
      # `(mento_pool_deviation_ratio - 1) * 100` in PromQL so the annotation
      # can use `printf "%.0f%%"` directly. We avoid `humanizePercentage`
      # because its `%.4g` format flips to scientific notation past 1e4
      # (a 122x breach would render "1.219e+04% above threshold" — see
      # local definition). Sprig `mul`/`sub` are NOT in scope for Grafana
      # annotation templates so the multiplication has to live in PromQL.
      # The `{{ if $values.Dev }}` guard handles the indexer's `-1`
      # sentinel path, where the bridge gates the gauge and `Dev` returns
      # no series.
      current_deviation = local.deviation_critical_current_deviation_annotation
      # Pre-rendered "17% axlUSDC / 83% USDm". Reads `humanizePercentage`
      # of each gauge value (already in [0, 1]) and the per-series
      # `token_symbol` label written by metrics-bridge. No sprig — map
      # access via `.Labels.token_symbol` is a Go-template builtin.
      # When metrics-bridge can't resolve a contract address it falls
      # back to literal "token0" / "token1" (matches the existing `pair`
      # fallback semantics).
      current_reserves = local.deviation_critical_current_reserves_annotation
      # Rebalance reason annotation, sourced from the metrics-bridge probe
      # (`mento_pool_rebalance_blocked`). The probe runs every Nth Hasura
      # poll for pools matching this rule's gate, so the label set ALWAYS
      # already carries the same `chain_id`/`pool_id`/`pair` identity as
      # the alert. Rendered in the Slack body via
      # `{{ if .Annotations.rebalance_reason }}` — see contact-points.tf.
      # When the probe hasn't run yet or the RPC failed, the gauge is
      # absent and this annotation expands to an empty string, which the
      # template suppresses.
      #
      # `$labels` in a Grafana alert annotation only exposes labels from
      # the firing series (query A — the breach gauge). Query B's labels
      # (`reason_code` / `reason_message`) live on its own series and are
      # accessible via `$values.B.Labels.*`. Reading `$labels.reason_*`
      # would always be empty.
      rebalance_reason = local.deviation_critical_rebalance_reason_annotation
    }

    labels = {
      service  = "fpmms"
      severity = "critical"
    }

    # The Prometheus expression: seconds since breach started, gated on BOTH
    # an active breach (breach_start > 0) AND current magnitude above 1.05
    # (5% over threshold). Only sustained large breaches escalate to critical;
    # smaller-but-prolonged breaches stay at warning. When either gate is
    # false, the series is dropped — threshold below never sees it.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = "(time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_ratio > 1.05) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0)"
        instant = true
      })
    }

    # Dev/R0/R1 — annotation-only queries. Not referenced by the threshold
    # node; they populate `$values.Dev` / `$values.R0` / `$values.R1` so
    # the annotations can render the current deviation magnitude and
    # reserve split alongside the breach duration. When the underlying
    # gauge has no series for this pool (e.g. ratio sentinel, both reserves
    # zero), the value is empty and the `{{ if }}` guards in the annotation
    # strings drop the line.
    #
    # Pre-computing `(ratio - 1) * 100` in PromQL (rather than at annotation
    # time) is required because sprig math (`sub`/`mul`) is unavailable in
    # Grafana annotation templates — only Prometheus helpers (`humanize`,
    # `humanizePercentage`, `humanizeDuration`, `printf`) and Go-template
    # builtins are. The `* 100` keeps the rendered value out of scientific
    # notation by using integer percent + `printf "%.0f%%"` instead of
    # humanizePercentage on a fractional input.
    data {
      ref_id         = "Dev"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Dev"
        expr    = "(mento_pool_deviation_ratio - 1) * 100"
        instant = true
      })
    }

    # R0 / R1 query the per-token reserve-share gauges — split into two
    # flat metrics (no `token_index` label) so the annotation per-instance
    # match against query A's labels (`pool_id, chain_id, pair`) actually
    # binds. A previous version queried `mento_pool_reserve_share{token_index}`,
    # whose extra label caused a fingerprint mismatch and silently dropped
    # `$values.R0` / `$values.R1` — the `current_reserves` annotation never
    # rendered. PR #234 review (Codex). Regression-tested in
    # metrics-bridge/test/metrics.test.ts ("label-shape parity"). The
    # `token_symbol` label IS present on these gauges and is consumed via
    # `$values.R0.Labels.token_symbol` in the annotation — that doesn't
    # break the per-instance match because Grafana matches on the firing
    # alert's fingerprint subset, and `token_symbol` is 1:1 with `pool_id`
    # so it never widens the cardinality.
    data {
      ref_id         = "R0"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "R0"
        expr    = "mento_pool_reserve_share_token0"
        instant = true
      })
    }

    data {
      ref_id         = "R1"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "R1"
        expr    = "mento_pool_reserve_share_token1"
        instant = true
      })
    }

    # B = rebalance-blocked annotation source. NOT part of the threshold
    # condition — the alert MUST still fire if the probe hasn't run yet
    # or the RPC failed (operators need to know about the breach
    # regardless of whether we have a reason). Grafana evaluates query
    # B independently; the annotation template reads its label set via
    # `$values.B.Labels.*` (NOT `$labels`, which exposes only the
    # condition query's labels). The expression is
    # `mento_pool_rebalance_blocked > 0` so the series is empty when the
    # probe couldn't determine a reason — the template's `{{ if … }}`
    # guard then collapses the annotation to an empty string.
    data {
      ref_id         = "B"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "B"
        expr    = "mento_pool_rebalance_blocked > 0"
        instant = true
      })
    }

    # Bal / Need — annotation-only sources for the reserve-collateral
    # enrichment. The metrics-bridge probe sets these gauges only on
    # `RLS_RESERVE_OUT_OF_COLLATERAL`; absent for non-reserve strategies and
    # for transport errors during enrichment. The annotation template guards
    # both before rendering, so the alert keeps firing without the balance
    # line on every other reason code.
    data {
      ref_id         = "Bal"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Bal"
        expr    = "mento_pool_rebalance_collateral_balance"
        instant = true
      })
    }

    data {
      ref_id         = "Need"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Need"
        expr    = "mento_pool_rebalance_collateral_needed"
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

  # Critical fallback for the data-gap window where the indexer has anchored
  # a breach for >1h but the bridge isn't publishing `mento_pool_deviation_ratio`
  # (the `-1` sentinel from metrics-bridge). Without this rule, the magnitude-
  # gated critical above silently drops alerts during ratio-gauge outages —
  # the anchored warning rule still fires, but at warning severity. Mirror of
  # the warning anchored rule, escalated to critical once the breach has
  # outlived the 1h grace.
  rule {
    name           = "Deviation Breach Critical (anchored)"
    condition      = "threshold"
    for            = "0s"
    exec_err_state = "Error"
    no_data_state  = "OK"

    annotations = {
      summary     = "Breach active for {{ humanizeDuration $values.A.Value }} — ratio gauge missing, can't confirm magnitude."
      description = "Check rebalancer liveness, oracle feed, and metrics-bridge."
      # By construction the anchored rule fires when the deviation ratio
      # gauge is absent — so `$values.Dev` will almost always be empty and
      # this annotation will drop. Kept for symmetry with the magnitude-
      # gated rule: if the bridge starts publishing again mid-breach, the
      # next eval re-derives a value and the line appears automatically.
      current_deviation = local.deviation_critical_current_deviation_annotation
      # Reserve share is independent of the deviation ratio gauge — even
      # when the ratio is in its `-1` sentinel state, the indexer is still
      # writing reserves on every Swap / ReserveUpdate, so this line
      # typically renders. See the magnitude-gated rule for the no-sprig
      # rationale.
      current_reserves = local.deviation_critical_current_reserves_annotation
      # Same rebalance-reason annotation as the magnitude-gated critical
      # rule. The metrics-bridge probe gates on `lastDeviationRatio > 1.05`
      # (which is the `-1` sentinel during data gaps, so eligible pools
      # in this state typically slip past) — but if a probe DID run before
      # the ratio gauge dropped, the most-recent reason annotation would
      # still be present here. Reads `$values.B.Labels.*` because `$labels`
      # exposes only the condition query's labels. When neither label is
      # set, the `{{ if … }}` guard collapses the annotation cleanly.
      rebalance_reason = local.deviation_critical_rebalance_reason_annotation
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
        expr    = "(time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0) unless on(chain_id, pool_id, pair) mento_pool_deviation_ratio"
        instant = true
      })
    }

    # Annotation-only queries (Dev/R0/R1) — see the magnitude-gated rule
    # for the rationale. They populate $values.{Dev,R0,R1} without
    # participating in the threshold condition.
    data {
      ref_id         = "Dev"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Dev"
        expr    = "(mento_pool_deviation_ratio - 1) * 100"
        instant = true
      })
    }

    # See the magnitude-gated rule for the rationale on the flat
    # token0 / token1 split — the same per-instance label match applies
    # here, and a `token_index` label on these queries would silently
    # drop the `current_reserves` annotation.
    data {
      ref_id         = "R0"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "R0"
        expr    = "mento_pool_reserve_share_token0"
        instant = true
      })
    }

    data {
      ref_id         = "R1"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "R1"
        expr    = "mento_pool_reserve_share_token1"
        instant = true
      })
    }

    # See the magnitude-gated critical rule for the rationale on why the
    # rebalance-blocked query is independent of the threshold condition.
    data {
      ref_id         = "B"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "B"
        expr    = "mento_pool_rebalance_blocked > 0"
        instant = true
      })
    }

    # See the magnitude-gated critical rule for the Bal / Need rationale —
    # both gauges are absent except on RLS_RESERVE_OUT_OF_COLLATERAL, and
    # the annotation template guards them before rendering the balance line.
    data {
      ref_id         = "Bal"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Bal"
        expr    = "mento_pool_rebalance_collateral_balance"
        instant = true
      })
    }

    data {
      ref_id         = "Need"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "Need"
        expr    = "mento_pool_rebalance_collateral_needed"
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
      contact_point   = local.notify_warning_pool.contact_point
      group_by        = local.notify_warning_pool.group_by
      group_wait      = local.notify_warning_pool.group_wait
      group_interval  = local.notify_warning_pool.group_interval
      repeat_interval = local.notify_warning_pool.repeat_interval
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
      summary     = "Latest rebalance effectiveness {{ printf \"%.2f\" $values.A.Value }} — control loop underperforming while still in breach."
      description = "Most recent in-breach rebalance closed less than 50% of the gap to the rebalance boundary AND no better rebalance has landed in the past 15 min. Likely stale-oracle race, MEV truncation, or sizing bug. Liveness OK — this is the effectiveness half of KPI 4. NOTE: effectiveness is measured against the boundary (`rebalanceThreshold`), not the oracle midpoint — 1.0 means the rebalance landed exactly on the boundary (ideal); values > 1.0 = overshoot; < 1.0 = under-correction."
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
    #      tolerance threshold in one signal, and stays consistent during ratio-
    #      gauge data gaps.
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

    # Fires when the most recent in-breach rebalance closed less than half
    # the gap to the boundary — the spec's "repeated low-effect rebalance"
    # signal (§3, KPI 4). Revisit threshold once production data lands.
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
      contact_point   = local.notify_warning_pool.contact_point
      group_by        = local.notify_warning_pool.group_by
      group_wait      = local.notify_warning_pool.group_wait
      group_interval  = local.notify_warning_pool.group_interval
      repeat_interval = local.notify_warning_pool.repeat_interval
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
      summary     = "Oracle jumped {{ printf \"%.2f\" $values.A.Value }} bps — above the pool's {{ if $values.Fee }}{{ printf \"%.0f\" $values.Fee.Value }}{{ else }}?{{ end }} bps swap fee. LPs leaking per arb round-trip."
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
      summary     = "Oracle jumped {{ printf \"%.2f\" $values.A.Value }} bps — ≥10% above the pool's {{ if $values.Fee }}{{ printf \"%.0f\" $values.Fee.Value }}{{ else }}?{{ end }} bps swap fee. LPs leaking per arb round-trip."
      description = "Most recent MedianUpdated delta is at least 10% above the pool's combined swap fee. Arbitrageurs can round-trip through the pool faster than rebalancing can catch, and the leakage compounds with volume. Investigate the oracle feed (stuck reporter, bridge-delay reopen, reporter disagreement) and the rebalancer's next-cycle response."
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
