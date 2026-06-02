# Alert rules for oracle report quality (`service = "oracles"`). Distinct from
# the Aegis `service = "oracle-relayers"` rules (relayer liveness / balances in
# rules-oracle-relayers.tf) and from the fee-relative `Oracle Price Jump` rules
# in rules-fpmms.tf (`service = "fpmms"`, LP-leakage framing). This file owns
# oracle *data-quality* signals: a single report deviating abnormally from the
# prior report, regardless of pool economics.
#
# Each rule sets `notification_settings` directly — bypasses the Aegis-owned
# root policy and sends straight to the Slack contact points in contact-points.tf
# (same convention as rules-fpmms.tf).
#
# Closes #704.

locals {
  # ── Consecutive-report outlier thresholds (basis points) ──────────────────
  # The alert fires when a feed's new median jumps by at least this much vs the
  # immediately-prior median (one MedianUpdated to the next). Split by feed type
  # because a 1% intraday FX move is normal but a 1% jump on a USD-pegged feed is
  # not. Both tiers sit well below the on-chain breaker `rateChangeThreshold`
  # (~15–400 bps depending on feed) so this catches outliers the breaker doesn't
  # trip on rather than duplicating it. Tune here if either feed class proves
  # noisy. See #704 for the grooming decision behind 1.0% / 0.5%.
  oracle_outlier_fx_bps         = 100 # 1.0% — non-USD-pegged (FX) feeds
  oracle_outlier_stablecoin_bps = 50  # 0.5% — USD-pegged (stablecoin) feeds

  # FX-pair selection reuses the canonical classifier in main.tf:
  #   `pair !~ usd_pegged_pair_regex`  → FX feed (at least one non-USD leg)
  #   `pair =~ usd_pegged_pair_regex`  → USD-pegged feed
  # Unmapped pools (metrics-bridge falls back to `pair = pool.id`) don't match
  # the USD regex, so they land in the FX arm and alert 24/7 — fail-safe. The
  # `pair =~ ".+/.+"` guard on the weekend-suppression arm keeps those unmapped
  # pools from being silenced on weekends (mirrors `fx_gated_liveness_ratio_promql`).
  #
  # Weekend FX suppression reuses `fx_oracle_pause_gate_promql` (Fri ≥21:00 UTC →
  # Sun <23:00 UTC + the Sun 23:00 reopen-grace hour) — the v3 PromQL equivalent
  # of the `weekend_mute` timing applied to the Aegis oracle-relayer policies.
  oracle_outlier_expr = <<-EOT
    (
      (
        mento_pool_oracle_jump_bps{pair!~"${local.usd_pegged_pair_regex}"} >= ${local.oracle_outlier_fx_bps}
        unless on(chain_id, pool_id, pair)
        (mento_pool_oracle_jump_bps{pair!~"${local.usd_pegged_pair_regex}", pair=~".+/.+"} and on() ${local.fx_oracle_pause_gate_promql})
      )
      or
      mento_pool_oracle_jump_bps{pair=~"${local.usd_pegged_pair_regex}"} >= ${local.oracle_outlier_stablecoin_bps}
    )
    and ((time() - mento_pool_oracle_jump_at) < ${local.instant_query_range_seconds})
  EOT

  # Annotation-only queries. JumpPct pre-divides bps by 100 in PromQL because
  # sprig math isn't in scope for Grafana annotation templates (same rationale
  # as `oracle_jump_critical_annotation_queries`). OraclePrice/OraclePrev plus
  # their ages give the on-call the current vs prior median at a glance. No
  # FeePct — fees are irrelevant to a data-quality outlier.
  oracle_outlier_annotation_queries = [
    {
      ref_id = "JumpPct"
      expr   = "mento_pool_oracle_jump_bps / 100"
    },
    {
      ref_id = "OraclePrice"
      expr   = "mento_pool_oracle_price"
    },
    {
      ref_id = "OraclePrev"
      expr   = "mento_pool_oracle_prev_price"
    },
    {
      ref_id = "AgeNow"
      expr   = "time() - mento_pool_oracle_jump_at"
    },
    {
      ref_id = "PrevAge"
      expr   = "time() - mento_pool_oracle_prev_price_at"
    },
  ]
}

# ── Consecutive-report outlier ───────────────────────────────────────────────
#
# Fires when a feed's latest median jumps by more than the feed-type threshold
# vs the immediately-prior median. The `mento_pool_oracle_jump_bps` gauge is
# `|newMedian − prevMedian| / prevMedian × 10⁴`, written by metrics-bridge on
# every MedianUpdated, so this is exactly the "report jumped X% vs the prior
# report" signal from #704.
#
# Common gates (same as the fee-relative `Oracle Price Jump` rules):
#   1. `(time() - mento_pool_oracle_jump_at) < 600` — only fire within 10 min of
#      the MedianUpdated that produced the jump. The gauge is last-write-wins, so
#      without this gate a single big jump would stay firing until the next
#      median (hours, for a quiet feed).
#   2. FX feeds are suppressed during the weekend market-closed window; USD-pegged
#      feeds keep alerting 24/7 (their oracles don't pause for FX hours).
resource "grafana_rule_group" "oracles_report_outlier" {
  name             = "Oracle Report Outlier"
  folder_uid       = grafana_folder.oracles.uid
  interval_seconds = 60

  rule {
    name      = "Oracle Report Outlier"
    condition = "threshold"
    # `for = "1m"` smooths transient NoData blips from the Mimir ruler. The
    # threshold is "any outlier jump within the last 10m", so this does not add a
    # meaningful duration requirement — same rationale as the `Oracle Price Jump`
    # rules in rules-fpmms.tf.
    for            = "1m"
    exec_err_state = "Error"
    no_data_state  = "OK"

    # JumpPct is nil-guarded with a `?` fallback: `mento_pool_oracle_jump_bps`
    # can be absent for a single eval cycle (bridge restart, Hasura blip), which
    # would otherwise nil-panic an unguarded `printf $values.JumpPct.Value`. The
    # price-history lines collapse cleanly when the indexer hasn't seen a second
    # non-zero MedianUpdated yet (the `0` sentinel is skipped by the bridge).
    annotations = {
      summary               = "Oracle report for {{ $labels.pair }} on {{ $labels.chain_name }} jumped {{ if $values.JumpPct }}{{ printf \"%.4g\" $values.JumpPct.Value }}{{ else }}?{{ end }}% vs the prior report — possible oracle outlier."
      description           = "The latest median moved more than the consecutive-report threshold (1.0% FX / 0.5% USD-pegged) vs the immediately-prior median. This sits below the on-chain breaker band, so the breaker won't have tripped — check the rate-feed reporters for a bad print or a stale source before the next report compounds it."
      current_oracle_price  = "{{ if and $values.OraclePrice $values.AgeNow }}{{ printf \"%.4g\" $values.OraclePrice.Value }} ({{ humanizeDuration $values.AgeNow.Value }} ago){{ end }}"
      previous_oracle_price = "{{ if and $values.OraclePrev $values.PrevAge }}{{ printf \"%.4g\" $values.OraclePrev.Value }} ({{ humanizeDuration $values.PrevAge.Value }} ago){{ end }}"
    }

    labels = {
      service  = "oracles"
      severity = "warning"
    }

    # A = jump bps for feeds breaching their feed-type threshold, fresh and
    # (for FX) outside the weekend window. The `and`/`unless` chain embeds the
    # full condition; the threshold node below just confirms A is non-empty.
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = local.instant_query_range_seconds
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = local.oracle_outlier_expr
        instant = true
      })
    }

    # Annotation-only queries — populate `$values.*` for the templates above.
    # NOT part of the threshold condition: a missing series leaves the matching
    # `{{ if }}` guard empty instead of suppressing the alert.
    dynamic "data" {
      for_each = local.oracle_outlier_annotation_queries
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
}
