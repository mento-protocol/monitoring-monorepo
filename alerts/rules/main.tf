provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_service_account_token
}

# One folder per `service` label. Protocol-wide folders live in this stack
# together with the global Grafana notification policy, while Aegis keeps only
# its service-health folder/dashboard in `aegis/terraform`.
resource "grafana_folder" "fpmms" {
  title = "FPMMs"
  uid   = "fpmms"
}

resource "grafana_folder" "oracles" {
  title = "Oracles"
  uid   = "oracles"
}

resource "grafana_folder" "metrics_bridge" {
  title = "Metrics Bridge"
  uid   = "metrics-bridge"
}

resource "grafana_folder" "indexer" {
  title = "Indexer"
  uid   = "indexer"
}

resource "grafana_folder" "cdps" {
  title = "CDPs"
  uid   = "cdps"
}

resource "grafana_folder" "oracle_relayers" {
  title = "Oracle Relayers"
}

data "grafana_folder" "reserve" {
  title = "Reserve"
}

# Aegis folder is owned by the aegis stack (aegis/terraform). The relocated
# Aegis service-health rule group (rules-aegis-service.tf, issue #706) lives in
# it, so look it up rather than creating a second folder.
data "grafana_folder" "aegis" {
  title = "Aegis"
}

resource "grafana_folder" "trading_modes" {
  title = "Trading Modes"
}

resource "grafana_folder" "trading_limits" {
  title = "Trading Limits"
}

locals {
  # Common evaluation window for instant queries. 10 minutes is enough to absorb
  # one missed scrape (30s) and still produce a fresh value on every 60s eval.
  instant_query_range_seconds = 600

  # ── FX weekend suppression ────────────────────────────────────────────────
  # FX markets are closed Fri 21:00 UTC → Sun 23:00 UTC, so pools whose
  # oracle feed is an FX rate (EUR, GBP, KES, BRL, …) legitimately stop
  # reporting over weekends. `mento_pool_oracle_ok` is a live scrape-time
  # freshness signal now, so live Oracle Down and ratio-based liveness both need
  # per-series FX pause suppression; otherwise a healthy paused FX feed pages
  # every weekend for reasons the operator can't fix. Raw contract-down remains
  # an always-on critical rule because a false contract flag is never an
  # expected market pause.
  #
  # Why PromQL-level gating instead of `grafana_mute_timing`: a mute timing
  # applies to the whole rule (every firing series), so using it here would
  # also silence crypto-pool liveness alerts on weekends. The `pair` label
  # (emitted by metrics-bridge/src/metrics.ts — canonicalised "EURm/USDm",
  # "USDC/USDm", etc.) lets us gate per-series instead.
  #
  # FX classification mirrors `isFxPool` in ui-dashboard/src/lib/tokens.ts —
  # a pair is FX iff at least one leg is NOT in the USD-pegged set. The regex
  # matches the USD-pegged set; apply with `!~` to select FX pairs. Keep in
  # sync with `USD_PEGGED_SYMBOLS` in tokens.ts and the `expectedLabel` pairs
  # in shared-config/__tests__/fixtures/known-pools.json. `USD₮` is the
  # Tugrik-sign USDT variant some sources emit.
  #
  # The `pair=~".+/.+"` guard on the unless-arm in `fx_gated_liveness_ratio_promql`
  # requires a well-formed `token0/token1` label before we silence anything.
  # `metrics-bridge` falls back to `pair = pool.id` (e.g. "42220-0xabc…") when
  # symbol derivation fails — without the guard, an unmapped pool would be
  # treated as FX and have its liveness alerts muted every weekend.
  #
  # Window matches `indexer-envio/config/fx-calendar.json` — close Fri 21:00
  # UTC, reopen Sun 23:00 UTC. day_of_week(): 0=Sun, 5=Fri, 6=Sat.
  usd_pegged_symbols_regex_part = "(USDm|USDC|USDT|USDT0|USD₮|AUSD|cUSD|axlUSDC)"
  usd_pegged_pair_regex = format(
    "^%s/%s$",
    local.usd_pegged_symbols_regex_part,
    local.usd_pegged_symbols_regex_part,
  )
  fx_weekend_gate_promql      = "(day_of_week() == 6 or (day_of_week() == 0 and hour() < 23) or (day_of_week() == 5 and hour() >= 21))"
  fx_reopen_grace_gate_promql = "(day_of_week() == 0 and hour() == 23)"
  fx_oracle_pause_gate_promql = format("(%s or %s)", local.fx_weekend_gate_promql, local.fx_reopen_grace_gate_promql)

  # Shared live Oracle Down / liveness suppressor. This intentionally stays pure
  # PromQL time/pair logic instead of depending on the new
  # `mento_pool_oracle_market_pause` gauge, so alert-rule rollout is safe even
  # before the bridge deploy that publishes the diagnostic pause metric.
  # The timestamp expression keeps a rollout fallback to the old raw timestamp
  # series so Grafana can apply before the bridge revision that publishes
  # `mento_pool_oracle_live_timestamp`.
  oracle_live_timestamp_compat_promql = "(mento_pool_oracle_live_timestamp or max without (last_oracle_update_url) (mento_pool_oracle_timestamp))"
  oracle_expiry_compat_promql         = "max without (last_oracle_update_url) (mento_pool_oracle_expiry)"
  oracle_live_age_promql              = format("time() - %s", local.oracle_live_timestamp_compat_promql)
  oracle_expiry_duration_part_promql = {
    OracleExpiryDays    = format("floor((%s) / 86400)", local.oracle_expiry_compat_promql)
    OracleExpiryHours   = format("floor(((%s) %% 86400) / 3600)", local.oracle_expiry_compat_promql)
    OracleExpiryMinutes = format("floor(((%s) %% 3600) / 60)", local.oracle_expiry_compat_promql)
    OracleExpirySeconds = format("floor((%s) %% 60)", local.oracle_expiry_compat_promql)
  }
  oracle_age_duration_part_promql = {
    OracleAgeDays    = format("floor((%s) / 86400)", local.oracle_live_age_promql)
    OracleAgeHours   = format("floor(((%s) %% 86400) / 3600)", local.oracle_live_age_promql)
    OracleAgeMinutes = format("floor(((%s) %% 3600) / 60)", local.oracle_live_age_promql)
    OracleAgeSeconds = format("floor((%s) %% 60)", local.oracle_live_age_promql)
  }

  # Grafana annotation templates can call `humanizeDuration`, but cannot
  # post-process its output. These oracle annotations use PromQL-derived
  # duration parts to omit trailing zero units in Slack copy: "6m 0s" -> "6m",
  # "1h 0m 0s" -> "1h", while keeping sub-minute values on humanizeDuration.
  oracle_update_window_duration_annotation = join("", [
    "{{ if and $values.OracleExpiry (gt $values.OracleExpiry.Value 0.0) }}",
    "{{ if and $values.OracleExpirySeconds (eq $values.OracleExpirySeconds.Value 0.0) }}",
    "{{ if and $values.OracleExpiryDays (gt $values.OracleExpiryDays.Value 0.0) }}",
    "{{ printf \"%.0fd\" $values.OracleExpiryDays.Value }}",
    "{{ if and $values.OracleExpiryHours (gt $values.OracleExpiryHours.Value 0.0) }} {{ printf \"%.0fh\" $values.OracleExpiryHours.Value }}{{ end }}",
    "{{ if and $values.OracleExpiryMinutes (gt $values.OracleExpiryMinutes.Value 0.0) }} {{ printf \"%.0fm\" $values.OracleExpiryMinutes.Value }}{{ end }}",
    "{{ else if and $values.OracleExpiryHours (gt $values.OracleExpiryHours.Value 0.0) }}",
    "{{ printf \"%.0fh\" $values.OracleExpiryHours.Value }}",
    "{{ if and $values.OracleExpiryMinutes (gt $values.OracleExpiryMinutes.Value 0.0) }} {{ printf \"%.0fm\" $values.OracleExpiryMinutes.Value }}{{ end }}",
    "{{ else if and $values.OracleExpiryMinutes (gt $values.OracleExpiryMinutes.Value 0.0) }}",
    "{{ printf \"%.0fm\" $values.OracleExpiryMinutes.Value }}",
    "{{ else }}",
    "{{ humanizeDuration $values.OracleExpiry.Value }}",
    "{{ end }}",
    "{{ else }}",
    "{{ humanizeDuration $values.OracleExpiry.Value }}",
    "{{ end }}",
    "{{ else }}",
    "expected",
    "{{ end }}",
  ])
  oracle_live_age_duration_annotation = join("", [
    "{{ if and $values.OracleAge (gt $values.OracleAge.Value 0.0) $values.OracleAgeSeconds (eq $values.OracleAgeSeconds.Value 0.0) }}",
    "{{ if and $values.OracleAgeDays (gt $values.OracleAgeDays.Value 0.0) }}",
    "{{ printf \"%.0fd\" $values.OracleAgeDays.Value }}",
    "{{ if and $values.OracleAgeHours (gt $values.OracleAgeHours.Value 0.0) }} {{ printf \"%.0fh\" $values.OracleAgeHours.Value }}{{ end }}",
    "{{ if and $values.OracleAgeMinutes (gt $values.OracleAgeMinutes.Value 0.0) }} {{ printf \"%.0fm\" $values.OracleAgeMinutes.Value }}{{ end }}",
    "{{ else if and $values.OracleAgeHours (gt $values.OracleAgeHours.Value 0.0) }}",
    "{{ printf \"%.0fh\" $values.OracleAgeHours.Value }}",
    "{{ if and $values.OracleAgeMinutes (gt $values.OracleAgeMinutes.Value 0.0) }} {{ printf \"%.0fm\" $values.OracleAgeMinutes.Value }}{{ end }}",
    "{{ else if and $values.OracleAgeMinutes (gt $values.OracleAgeMinutes.Value 0.0) }}",
    "{{ printf \"%.0fm\" $values.OracleAgeMinutes.Value }}",
    "{{ else }}",
    "{{ humanizeDuration $values.OracleAge.Value }}",
    "{{ end }}",
    "{{ else }}",
    "{{ humanizeDuration $values.OracleAge.Value }}",
    "{{ end }}",
  ])
  fx_oracle_pause_promql = format(
    "(mento_pool_oracle_live_timestamp{pair!~\"%s\",pair=~\".+/.+\"} or max without (last_oracle_update_url) (mento_pool_oracle_timestamp{pair!~\"%s\",pair=~\".+/.+\"})) and on() %s",
    local.usd_pegged_pair_regex,
    local.usd_pegged_pair_regex,
    local.fx_oracle_pause_gate_promql,
  )

  # Liveness ratio with FX market-pause suppression. The `unless` arm selects
  # the live oracle-timestamp series for FX pairs during the weekend +
  # reopen-grace windows — those series are dropped from the main ratio. Using
  # `mento_pool_oracle_live_timestamp` (not the ratio itself) for the
  # suppression match avoids re-evaluating the division twice per tick.
  # Referenced by the warning + critical rules in rules-fpmms.tf.
  fx_gated_liveness_ratio_promql = format(
    "((time() - %s) / ignoring(last_oracle_update_url) (%s > 0)) unless on(chain_id, pool_id, pair) (%s)",
    local.oracle_live_timestamp_compat_promql,
    local.oracle_expiry_compat_promql,
    local.fx_oracle_pause_promql,
  )

  # During rollout the alert rules can apply before metrics-bridge publishes
  # the split raw contract flag. Fall back to the legacy `oracle_ok` series
  # only for Oracle Contract Down: before the bridge split, that metric means
  # raw contract can-trade, not live freshness.
  oracle_contract_down_active_promql = "mento_pool_oracle_contract_ok or mento_pool_oracle_ok"
  # Oracle Down should not double-page when the raw contract flag is already
  # false; Oracle Contract Down owns that failure. Do not fall back to legacy
  # `mento_pool_oracle_ok` here because pre-split bridge revisions used it for
  # the raw contract flag, not scrape-time liveness.
  oracle_live_down_unpaused_promql = "mento_pool_oracle_ok and on(chain_id, pool_id, pair) (mento_pool_oracle_contract_ok > 0.5)"
  oracle_live_down_active_promql   = "(${local.oracle_live_down_unpaused_promql}) unless on(chain_id, pool_id, pair) (${local.fx_oracle_pause_promql})"

  # Shared per-series weekend suppressors for deviation/rebalancer rules.
  # They intentionally gate only FX pairs (non-USD-pegged pair labels) and
  # leave USD-pegged pools such as USDC/USDm and USDT/USDm alerting 24/7.
  fx_weekend_suppressed_deviation_ratio_promql = format(
    "mento_pool_deviation_ratio{pair!~\"%s\",pair=~\".+/.+\"} and on() %s",
    local.usd_pegged_pair_regex,
    local.fx_weekend_gate_promql,
  )

  fx_weekend_suppressed_breach_start_promql = format(
    "mento_pool_deviation_breach_start{pair!~\"%s\",pair=~\".+/.+\"} and on() %s",
    local.usd_pegged_pair_regex,
    local.fx_weekend_gate_promql,
  )

  # Rebalancer Stale needs a short FX reopen grace after the broader weekend
  # gate drops. Sydney has only been open for ~1h at Sun 23:00 UTC, so paging
  # immediately at 23:05 UTC is mostly noise for FX pairs. Keep this separate
  # from the shared deviation gate so Deviation Breach resumes at reopen.
  fx_rebalancer_stale_gate_promql = format("(%s or %s)", local.fx_weekend_gate_promql, local.fx_reopen_grace_gate_promql)
  fx_rebalancer_stale_suppressed_breach_start_promql = format(
    "mento_pool_deviation_breach_start{pair!~\"%s\",pair=~\".+/.+\"} and on() %s",
    local.usd_pegged_pair_regex,
    local.fx_rebalancer_stale_gate_promql,
  )

  # Critical magnitude is sticky for the life of the open breach: once the
  # indexer's open-breach peak has crossed 1.05x, the critical alert stays
  # responsible until the current ratio is back within the warning tolerance.
  # The `or` fallback keeps the old current-ratio-only semantics during the
  # rollout window before metrics-bridge publishes the peak-ratio gauge.
  deviation_critical_magnitude_promql = "(mento_pool_deviation_open_breach_peak_ratio > 1.05) or on(chain_id, pool_id, pair) (mento_pool_deviation_ratio > 1.05)"
  deviation_critical_gate_promql = format(
    "((time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_ratio > 1.01) and on(chain_id, pool_id, pair) (%s) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0)) unless (%s)",
    local.deviation_critical_magnitude_promql,
    local.fx_weekend_suppressed_breach_start_promql,
  )
  # Metrics-bridge only publishes critical alert_state after the critical
  # rule's own 1m dwell could have elapsed. Suppress warning coverage on that
  # state, not on breach age alone, so late critical-magnitude or data-gap
  # changes cannot resolve warning before critical can actually fire. During
  # rollout, fall back to the previous age-based suppression per pool until any
  # alert_state series exists for that pool.
  deviation_critical_suppression_seconds       = 3780
  deviation_alert_state_present_promql         = "max without(state) (mento_pool_deviation_alert_state)"
  deviation_critical_state_ready_promql        = "max without(state) (mento_pool_deviation_alert_state{state=~\"critical|deviation_ratio_unavailable_critical\"} > 0)"
  deviation_critical_legacy_active_promql      = "(${local.deviation_critical_gate_promql}) > ${local.deviation_critical_suppression_seconds}"
  deviation_critical_ready_promql              = "(${local.deviation_critical_state_ready_promql}) or on(chain_id, pool_id, pair) ((${local.deviation_critical_legacy_active_promql}) unless on(chain_id, pool_id, pair) (${local.deviation_alert_state_present_promql}))"
  deviation_warning_unavailable_base_promql    = "((time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0) unless on(chain_id, pool_id, pair) mento_pool_deviation_ratio) unless (${local.fx_weekend_suppressed_breach_start_promql})"
  deviation_warning_unavailable_rollout_promql = "(${local.deviation_alert_state_present_promql}) or (((time() - mento_pool_deviation_breach_start) <= ${local.deviation_critical_suppression_seconds}) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0))"
  deviation_warning_active_promql              = "((mento_pool_deviation_ratio unless (${local.fx_weekend_suppressed_deviation_ratio_promql})) unless on(chain_id, pool_id, pair) (${local.deviation_critical_ready_promql}))"
  deviation_warning_unavailable_active_promql  = "((${local.deviation_warning_unavailable_base_promql}) unless on(chain_id, pool_id, pair) (${local.deviation_critical_state_ready_promql})) and on(chain_id, pool_id, pair) (${local.deviation_warning_unavailable_rollout_promql})"
  deviation_critical_unavailable_active_promql = "(((time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0) unless on(chain_id, pool_id, pair) mento_pool_deviation_ratio) unless (${local.fx_weekend_suppressed_breach_start_promql}))"

  # Transition markers let resolved notifications say why an alert stopped
  # instead of listing every possible cause. Each base alert rule adds the
  # matching query as annotation-only `Info`; it is not part of the threshold
  # condition. Grafana can mark the whole rule NoData when an annotation query
  # returns zero series, so each `Info` query falls back to a zero-valued series
  # matching the base alert's own active label set. The transition marker wins
  # when present and carries the reason labels; the fallback only keeps active
  # alerts evaluable between transitions.
  deviation_warning_resolved_transition_promql              = "mento_pool_deviation_alert_transition_active{from=\"warning\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0"
  deviation_warning_unavailable_resolved_transition_promql  = "mento_pool_deviation_alert_transition_active{from=\"deviation_ratio_unavailable_warning\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0"
  deviation_critical_resolved_transition_promql             = "mento_pool_deviation_alert_transition_active{from=\"critical\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0"
  deviation_critical_unavailable_resolved_transition_promql = "mento_pool_deviation_alert_transition_active{from=\"deviation_ratio_unavailable_critical\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0"
  deviation_warning_resolved_info_promql                    = "(${local.deviation_warning_resolved_transition_promql}) or on(chain_id, pool_id, pair) (0 * (${local.deviation_warning_active_promql}))"
  deviation_warning_unavailable_resolved_info_promql        = "(${local.deviation_warning_unavailable_resolved_transition_promql}) or on(chain_id, pool_id, pair) (0 * (${local.deviation_warning_unavailable_active_promql}))"
  deviation_critical_resolved_info_promql                   = "(${local.deviation_critical_resolved_transition_promql}) or on(chain_id, pool_id, pair) (0 * (${local.deviation_critical_gate_promql}))"
  deviation_critical_unavailable_resolved_info_promql       = "(${local.deviation_critical_unavailable_resolved_transition_promql}) or on(chain_id, pool_id, pair) (0 * (${local.deviation_critical_unavailable_active_promql}))"

  # ── Deviation Breach annotations ─────────────────────────────────────────
  # Deviation-breach rules render the same Slack diagnostic lines, so we
  # author the shared copy and formatting once here.
  #
  # IMPORTANT — Grafana annotation templates expose Go text/template
  # builtins (`if`, `and`, `index`, `eq`, `len`, …) plus a small set of
  # Prometheus helpers (`humanize`, `humanizePercentage`, `humanizeDuration`,
  # `printf`). Sprig (`mul`, `sub`, `splitList`, etc.) is NOT in scope —
  # it's only available in `grafana_contact_point` notification templates.
  # See `pkg/services/ngalert/state/template/funcs.go` upstream. PR #211
  # commit `50acbd3` removed `mul` from a different annotation for exactly
  # this reason.
  #
  # Strategy:
  #   - `deviation_*_summary` reads `$values.Dev.Value` from a query that
  #     pre-computes `(mento_pool_deviation_ratio - 1) * 100` in PromQL.
  #     The warning rule reads its duration from `$values.BreachAge`; the
  #     critical rule already uses `$values.A` as breach age. Rendering branches
  #     by magnitude so summaries stay scannable across four orders of
  #     magnitude ("Pool 5% above…" → "Pool 44M% above…"):
  #     If `Dev` is absent, the critical fallback can still render `$values.A`
  #     because A is the firing breach-age condition for that rule.
  #       - < 1000:   integer percent ("44%")
  #       - 1000–9999: thousand-separated ("1,234%") — Go templates have
  #         no native %`,d formatter and Grafana's template engine doesn't
  #         expose sprig math, so the integer-quotient and remainder are
  #         pre-computed in PromQL (`DevQ`/`DevR`) and stitched back
  #         together with `printf "%.0f,%03.0f"`.
  #       - ≥ 10000:  Prometheus `humanize` ("10.23k%", "44.08M%") to
  #         keep the line short. Same reason we avoid `humanizePercentage`
  #         on the < 1000 branch — its `%.4g` format flips to scientific
  #         notation above 1e4, which is the regime we explicitly want
  #         humanize for instead.
  #   - `current_reserves` reads `$values.R0.Value` / `$values.R1.Value`
  #     from queries that pre-compute reserve shares as integer-percent
  #     inputs in PromQL (`share * 100`) plus `.Labels.token_symbol` from
  #     each series to render "axlUSDC / USDm". Map access is a Go template
  #     builtin.
  #   - `printf "%.0f%%"` keeps tiny drained legs as "0%" instead of
  #     `humanizePercentage` scientific notation like "8.227e-05%".
  #     Rounding to whole percentages is intentional here: the diagnostic
  #     alert signal is "100% USDT / 0% USDm", not tiny dust precision.
  #   - `rebalance_reason` reads `$values.B.Labels.reason_message` for the
  #     bounded Solidity-error explanation. The decoded `reason_code` remains
  #     on the gauge for diagnostics, but is intentionally not rendered in
  #     Slack. The message is terminated with a period in the template since
  #     ERROR_MESSAGES entries are bare phrases — keeps the shared dashboard
  #     tooltip's em-dash-joined render path uncluttered.
  #   - For reserve-strategy pools, `rebalance_reason` OPTIONALLY appends
  #     ` Reserve Balance: X.XX <token>` when the firing pool's `pair` matches
  #     a USD-pegged stable we have Aegis coverage for (Celo: USDC / USDT /
  #     axlUSDC; Monad: USDC / USDT0 / AUSD — added in issue #707).
  #     The balance value is read from Aegis's existing per-token
  #     `${TOKEN}_balanceOf{owner="Reserve",chain=$CHAIN}` series —
  #     production-stable for years and refreshed every 10s — rather than a
  #     metrics-bridge probe (the in-bridge enrichment shipped in PR #237
  #     failed in production with `[REBALANCE_PROBE_FAILED]: Missing or
  #     invalid parameters`, leaving the gauges absent, which propagated
  #     NoData through this rule and stuck the critical alerts in Normal for
  #     ~9h on 2026-04-28).
  deviation_warning_summary_annotation            = <<-EOT
    {{- if $values.Dev -}}
      {{- $dev := $values.Dev.Value -}}
      {{- if lt $dev 1000.0 -}}
        {{- if $values.BreachAge -}}
          {{- printf "Pool %.0f%% above 1%% tolerance for %s." $dev (humanizeDuration $values.BreachAge.Value) -}}
        {{- else -}}
          {{- printf "Pool %.0f%% above 1%% tolerance." $dev -}}
        {{- end -}}
      {{- else if and (lt $dev 10000.0) $values.DevQ $values.DevR -}}
        {{- if $values.BreachAge -}}
          {{- printf "Pool %.0f,%03.0f%% above 1%% tolerance for %s." $values.DevQ.Value $values.DevR.Value (humanizeDuration $values.BreachAge.Value) -}}
        {{- else -}}
          {{- printf "Pool %.0f,%03.0f%% above 1%% tolerance." $values.DevQ.Value $values.DevR.Value -}}
        {{- end -}}
      {{- else -}}
        {{- if $values.BreachAge -}}
          {{- printf "Pool %s%% above 1%% tolerance for %s." (humanize $dev) (humanizeDuration $values.BreachAge.Value) -}}
        {{- else -}}
          {{- printf "Pool %s%% above 1%% tolerance." (humanize $dev) -}}
        {{- end -}}
      {{- end -}}
    {{- else if $values.BreachAge -}}
      Pool above 1% tolerance for {{ humanizeDuration $values.BreachAge.Value }}.
    {{- else -}}
      Pool above 1% tolerance.
    {{- end -}}
  EOT
  deviation_critical_summary_annotation           = <<-EOT
    {{- if $values.Dev -}}
      {{- $dev := $values.Dev.Value -}}
      {{- $age := humanizeDuration $values.A.Value -}}
      {{- if lt $dev 5.0 -}}
        {{- printf "Pool crossed 5%% threshold and remains %.0f%% above 1%% tolerance for %s — rebalancer not closing breach." $dev $age -}}
      {{- else if lt $dev 1000.0 -}}
        {{- printf "Pool %.0f%% above 5%% threshold for %s — rebalancer not closing breach." $dev $age -}}
      {{- else if and (lt $dev 10000.0) $values.DevQ $values.DevR -}}
        {{- printf "Pool %.0f,%03.0f%% above 5%% threshold for %s — rebalancer not closing breach." $values.DevQ.Value $values.DevR.Value $age -}}
      {{- else -}}
        {{- printf "Pool %s%% above 5%% threshold for %s — rebalancer not closing breach." (humanize $dev) $age -}}
      {{- end -}}
    {{- else -}}
      Pool above 5% threshold for {{ humanizeDuration $values.A.Value }} — rebalancer not closing breach.
    {{- end -}}
  EOT
  deviation_current_reserves_annotation           = <<-EOT
    {{- if and $values.R0 $values.R1 -}}
      {{- printf "%.0f%%" $values.R0.Value }} {{ $values.R0.Labels.token_symbol }} / {{ printf "%.0f%%" $values.R1.Value }} {{ $values.R1.Labels.token_symbol }}
    {{- end -}}
  EOT
  deviation_transition_summary_annotation         = <<-EOT
    {{- if $values.Info -}}
      {{- $reason := index $values.Info.Labels "reason" -}}
      {{- if eq $reason "recovered" -}}
        Pool is back within tolerance.
      {{- else if eq $reason "escalated_to_critical" -}}
        Warning escalated to critical.
      {{- else if eq $reason "deescalated_to_warning" -}}
        Critical alert de-escalated to warning.
      {{- else if eq $reason "deviation_ratio_unavailable" -}}
        Deviation-ratio data is unavailable while the breach is still open.
      {{- else if eq $reason "deviation_ratio_restored" -}}
        Deviation-ratio data is available again while the breach is still open.
      {{- else if eq $reason "fx_weekend_suppressed" -}}
        Alert paused because FX weekend suppression is active.
      {{- else -}}
        Deviation alert state changed: {{ $reason }}.
      {{- end -}}
    {{- else -}}
      Deviation alert state changed.
    {{- end -}}
  EOT
  deviation_resolved_summary_annotation           = <<-EOT
    {{- if $values.Info -}}
      {{- $reason := index $values.Info.Labels "reason" -}}
      {{- if $reason -}}
        {{- if eq $reason "recovered" -}}
          Pool is back within tolerance.
        {{- else if eq $reason "escalated_to_critical" -}}
          Warning escalated to critical.
        {{- else if eq $reason "deescalated_to_warning" -}}
          Critical alert de-escalated to warning.
        {{- else if eq $reason "deviation_ratio_unavailable" -}}
          Deviation-ratio data is unavailable while the breach is still open.
        {{- else if eq $reason "deviation_ratio_restored" -}}
          Deviation-ratio data is available again while the breach is still open.
        {{- else if eq $reason "fx_weekend_suppressed" -}}
          Alert paused because FX weekend suppression is active.
        {{- else -}}
          Alert stopped because of transition reason: {{ $reason }}.
        {{- end -}}
      {{- else -}}
        Alert stopped, but the transition reason marker was unavailable.
      {{- end -}}
    {{- else -}}
      Alert stopped, but the transition reason marker was unavailable.
    {{- end -}}
  EOT
  deviation_transition_breach_duration_annotation = <<-EOT
    {{- if $values.Info -}}{{ index $values.Info.Labels "breach_duration" }}{{- end -}}
  EOT
  deviation_transition_breach_started_annotation  = <<-EOT
    {{- if $values.Info -}}{{ index $values.Info.Labels "breach_started_at" }}{{- end -}}
  EOT
  deviation_transition_breach_ended_annotation    = <<-EOT
    {{- if $values.Info -}}{{ index $values.Info.Labels "breach_ended_at" }}{{- end -}}
  EOT
  # HEREDOC keeps the multi-branch template legible — `{{-`/`-}}` whitespace
  # trim markers strip ALL surrounding whitespace (including newlines), so
  # the output collapses to a single line at render time.
  #
  # Branches:
  #   - outer `{{ if $values.B }}` — guards on the rebalance-blocked gauge
  #     producing a series at all (probe didn't run / RPC down → no
  #     annotation line).
  #   - `{{ if $rm }}` — `reason_message` is 1:1 with `reason_code` by
  #     construction; the nil-and-emptystring guard is defensive against
  #     a misconfigured probe writing the gauge without the label.
  #     Renders the bounded message with a period; the decoded custom-error
  #     code stays available on the Prometheus label for diagnostics.
  #   - inner Aegis dispatch — each ResX query is already pair-scoped via
  #     the cross-join (pair="USDC/USDm" etc.), so only the matching pool
  #     instance sees a non-nil $values.ResX. The chain/pair guards here
  #     are defensive but harmless. New stable pairs need both an Aegis
  #     Treb source and a new branch here + a new cross-join query.
  deviation_rebalance_reason_annotation = <<-EOT
    {{- if $values.B -}}
      {{- $rm := index $values.B.Labels "reason_message" -}}
      {{- if $rm -}}
        {{- $rm }}.
        {{- $pair := index $labels "pair" -}}
        {{- $chain := index $labels "chain_name" -}}
        {{- if and (eq $chain "celo") (eq $pair "USDC/USDm") $values.ResUSDC -}}
          {{ " Reserve Balance: " }}{{ printf "%.2f" $values.ResUSDC.Value }} USDC
        {{- else if and (eq $chain "celo") (eq $pair "USDT/USDm") $values.ResUSDT -}}
          {{ " Reserve Balance: " }}{{ printf "%.2f" $values.ResUSDT.Value }} USDT
        {{- else if and (eq $chain "celo") (eq $pair "axlUSDC/USDm") $values.ResAxlUSDC -}}
          {{ " Reserve Balance: " }}{{ printf "%.2f" $values.ResAxlUSDC.Value }} axlUSDC
        {{- else if and (eq $chain "monad") (eq $pair "USDC/USDm") $values.ResUSDC -}}
          {{ " Reserve Balance: " }}{{ printf "%.2f" $values.ResUSDC.Value }} USDC
        {{- else if and (eq $chain "monad") (eq $pair "USDT0/USDm") $values.ResUSDT0 -}}
          {{ " Reserve Balance: " }}{{ printf "%.2f" $values.ResUSDT0.Value }} USDT0
        {{- else if and (eq $chain "monad") (eq $pair "AUSD/USDm") $values.ResAUSD -}}
          {{ " Reserve Balance: " }}{{ printf "%.2f" $values.ResAUSD.Value }} AUSD
        {{- end -}}
      {{- end -}}
    {{- end -}}
  EOT

  # ── Deviation Breach annotation-only data sources ────────────────────────
  # Deviation breach rules wire the same instant queries into `$values.*` so
  # the annotation locals above can render.
  # Authored once here and consumed by `dynamic` blocks in `rules-fpmms.tf`
  # so a query-shape change (new annotation, different time range) lands
  # in one place. The threshold node is rule-specific (warning has a
  # different bound than critical), so it stays inline in each rule.
  #
  # Aegis-sourced reserve balances (ResUSDC / ResUSDT / ResAxlUSDC on Celo;
  # ResUSDC / ResUSDT0 / ResAUSD on Monad — issue #707):
  #   - Read Aegis's `${TOKEN}_balanceOf{owner="Reserve"}` series, one per
  #     chain via the `chain` label (production-stable for years on Celo;
  #     refreshed every 10s via Treb-driven RPC reads in the Aegis NestJS
  #     service).
  #   - ResUSDC is chain-agnostic (USDC/USDm exists on both chains); ResUSDT /
  #     ResAxlUSDC are Celo-only and ResUSDT0 / ResAUSD are Monad-only, so each
  #     binds to its own chain's pool instances via the `on(chain_name)` join.
  #   - The `*_balanceOf` gauges are ALREADY in whole-token units — Aegis
  #     divides by the token's decimals before exporting (metric.ts
  #     `tokenAmountToWholeUnits`, e.g. USDC_balanceOf{chain="celo"} ≈ 127909).
  #     So the query uses the gauge value directly; do NOT divide by 1e6 (that
  #     would render 127909 as "0.13"). `printf "%.2f"` then shows whole tokens.
  #   - Aegis emits labels {chain="celo", job="aegis-metrics", owner=
  #     "Reserve", ownerValue=...} — no pool_id / pair — so a bare query
  #     returns no match against the per-pool alert instances. Fix: cross-
  #     join via `label_replace(…) * on(chain_name) group_left(pool_id,
  #     pair, …) (mento_pool_deviation_ratio{pair=X} * 0 + 1)`.
  #     label_replace renames "chain" → "chain_name" for the join key;
  #     the `* 0 + 1` scalar ensures the multiplier is 1 (not the deviation
  #     value); pair filter scopes each ResX var to its own alert instance.
  deviation_annotation_queries = [
    {
      ref_id = "Dev"
      expr   = "(mento_pool_deviation_ratio - 1) * 100"
    },
    # DevQ / DevR pre-compute the thousand-quotient and remainder of `Dev`
    # so the annotation template can stitch a thousand-separated number
    # ("1,234%") for the 1000–9999 range without sprig math (unavailable
    # in Grafana templates) or string manipulation (unavailable in PromQL).
    # Both rounded to integers in PromQL via `floor` so the template's
    # `%03.0f` doesn't accidentally render a fractional remainder as 4
    # digits ("9,1000%") on values like 9999.5. Side effect: the comma
    # branch FLOORS (1234.7 → "1,234") whereas the < 1000 branch ROUNDS
    # via `printf "%.0f"` (999.5 → "1000"). The 1-unit discrepancy in
    # the comma window is unobservable — these are 4-digit %s on a 5%
    # threshold, integer fidelity is fine. Outside the 1000–9999 window
    # the template ignores these and uses the integer or humanize branch
    # instead.
    {
      ref_id = "DevQ"
      expr   = "floor(((mento_pool_deviation_ratio - 1) * 100) / 1000)"
    },
    {
      ref_id = "DevR"
      expr   = "floor((mento_pool_deviation_ratio - 1) * 100) % 1000"
    },
    {
      ref_id = "R0"
      expr   = "mento_pool_reserve_share_token0 * 100"
    },
    {
      ref_id = "R1"
      expr   = "mento_pool_reserve_share_token1 * 100"
    },
    {
      ref_id = "B"
      expr   = "mento_pool_rebalance_blocked > 0"
    },
    # ResUSDC is chain-AGNOSTIC: USDC/USDm pools exist on both Celo and Monad.
    # Both operands omit a chain pin so `label_replace(...) * on(chain_name)
    # group_left(...)` produces one balance row per chain (celo, monad), each
    # joining to its own pool instance. ResUSDT / ResAxlUSDC stay Celo-pinned
    # (those tokens are Celo-only; Monad uses USDT0 / AUSD below).
    {
      ref_id = "ResUSDC"
      expr   = "label_replace(USDC_balanceOf{owner=\"Reserve\"}, \"chain_name\", \"$1\", \"chain\", \"(.*)\") * on(chain_name) group_left(chain_id, pool_id, pair, pool_address_short, block_explorer_url, job, instance) (mento_pool_deviation_ratio{pair=\"USDC/USDm\"} * 0 + 1)"
    },
    {
      ref_id = "ResUSDT"
      expr   = "label_replace(USDT_balanceOf{owner=\"Reserve\", chain=\"celo\"}, \"chain_name\", \"$1\", \"chain\", \"(.*)\") * on(chain_name) group_left(chain_id, pool_id, pair, pool_address_short, block_explorer_url, job, instance) (mento_pool_deviation_ratio{chain_name=\"celo\", pair=\"USDT/USDm\"} * 0 + 1)"
    },
    {
      ref_id = "ResAxlUSDC"
      expr   = "label_replace(axlUSDC_balanceOf{owner=\"Reserve\", chain=\"celo\"}, \"chain_name\", \"$1\", \"chain\", \"(.*)\") * on(chain_name) group_left(chain_id, pool_id, pair, pool_address_short, block_explorer_url, job, instance) (mento_pool_deviation_ratio{chain_name=\"celo\", pair=\"axlUSDC/USDm\"} * 0 + 1)"
    },
    # Monad reserve tokens (issue #707). USDT0/AUSD are Monad-only; both
    # operands pin chain="monad" for parity with the Celo-token queries above,
    # so a future same-named token on another chain can't silently fan out.
    {
      ref_id = "ResUSDT0"
      expr   = "label_replace(USDT0_balanceOf{owner=\"Reserve\", chain=\"monad\"}, \"chain_name\", \"$1\", \"chain\", \"(.*)\") * on(chain_name) group_left(chain_id, pool_id, pair, pool_address_short, block_explorer_url, job, instance) (mento_pool_deviation_ratio{chain_name=\"monad\", pair=\"USDT0/USDm\"} * 0 + 1)"
    },
    {
      ref_id = "ResAUSD"
      expr   = "label_replace(AUSD_balanceOf{owner=\"Reserve\", chain=\"monad\"}, \"chain_name\", \"$1\", \"chain\", \"(.*)\") * on(chain_name) group_left(chain_id, pool_id, pair, pool_address_short, block_explorer_url, job, instance) (mento_pool_deviation_ratio{chain_name=\"monad\", pair=\"AUSD/USDm\"} * 0 + 1)"
    },
  ]

  deviation_reserve_annotation_queries = [
    for query in local.deviation_annotation_queries : query
    if contains(["R0", "R1"], query.ref_id)
  ]

  # Rebalancer liveness/effectiveness alerts only render `rebalance_reason`.
  # Keep their annotation-only data to the blocked-reason + reserve-balance
  # subset so unused deviation/reserve-share queries cannot add eval cost or
  # widen the NoData surface.
  deviation_rebalancer_annotation_queries = [
    for query in local.deviation_annotation_queries : query
    if contains(["B", "ResUSDC", "ResUSDT", "ResAxlUSDC", "ResUSDT0", "ResAUSD"], query.ref_id)
  ]

  # ── Oracle Jump Critical annotation-only data sources ─────────────────────
  # Annotation queries for the `Oracle Jump Far Above Swap Fee` rule, fed
  # into the rule's `dynamic "data"` block. Same pattern as
  # `deviation_annotation_queries` above — kept out of the threshold
  # condition so a missing series leaves the matching annotation guard
  # empty instead of suppressing the alert.
  #
  # JumpPct / FeePct pre-divide bps by 100 in PromQL because sprig math
  # (`mul`/`div`) isn't in scope for Grafana annotation templates. AgeNow
  # reuses `mento_pool_oracle_jump_at` (== `lastMedianAt` at fire time, the
  # handler updates them together when `jumpBps != null`) so we don't need
  # a separate `oracle_price_at` metric.
  oracle_jump_critical_annotation_queries = [
    {
      ref_id = "JumpPct"
      expr   = "mento_pool_oracle_jump_bps / 100"
    },
    {
      ref_id = "FeePct"
      expr   = "mento_pool_swap_fee_bps / 100"
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

  # Warning-tier subset — same JumpPct / FeePct, no price-history annotations.
  # Defined separately rather than slicing the critical list so a future
  # warning-only annotation (e.g. "X-th jump in last hour") has a place to
  # land without touching the critical query set.
  oracle_jump_warning_annotation_queries = [
    {
      ref_id = "JumpPct"
      expr   = "mento_pool_oracle_jump_bps / 100"
    },
    {
      ref_id = "FeePct"
      expr   = "mento_pool_swap_fee_bps / 100"
    },
  ]
}
