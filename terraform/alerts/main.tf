provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_service_account_token
}

# One folder per `service` label — same split as the Aegis convention
# (Oracle Relayers / Reserve / Trading Modes / Trading Limits are each their
# own folder). Future `oracles` + `cdps` folders land when those rule groups
# do; empty folders aren't created preemptively.
resource "grafana_folder" "fpmms" {
  title = "FPMMs"
  uid   = "fpmms"
}

resource "grafana_folder" "metrics_bridge" {
  title = "Metrics Bridge"
  uid   = "metrics-bridge"
}

resource "grafana_folder" "indexer" {
  title = "Indexer"
  uid   = "indexer"
}

locals {
  # Common evaluation window for instant queries. 10 minutes is enough to absorb
  # one missed scrape (30s) and still produce a fresh value on every 60s eval.
  instant_query_range_seconds = 600

  # ── FX weekend suppression ────────────────────────────────────────────────
  # FX markets are closed Fri 21:00 UTC → Sun 23:00 UTC, so pools whose
  # oracle feed is an FX rate (EUR, GBP, KES, BRL, …) legitimately stop
  # reporting over weekends. These pools still fire `mento_pool_oracle_ok`
  # correctly when the contract-level expiry is crossed — that path is
  # handled by the separate Oracle Down rule and stays armed always — but
  # the ratio-based liveness thresholds would page every weekend for
  # reasons the operator can't fix.
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
  fx_weekend_gate_promql = "(day_of_week() == 6 or (day_of_week() == 0 and hour() < 23) or (day_of_week() == 5 and hour() >= 21))"

  # Liveness ratio with FX weekend suppression. The `unless` arm selects the
  # oracle-timestamp series for FX pairs during the weekend window — those
  # series are dropped from the main ratio. Using `mento_pool_oracle_timestamp`
  # (not the ratio itself) for the suppression match avoids re-evaluating the
  # division twice per tick. Referenced by the warning + critical rules in
  # rules-fpmms.tf.
  fx_gated_liveness_ratio_promql = format(
    "((time() - mento_pool_oracle_timestamp) / (mento_pool_oracle_expiry > 0)) unless (mento_pool_oracle_timestamp{pair!~\"%s\",pair=~\".+/.+\"} and on() %s)",
    local.usd_pegged_pair_regex,
    local.fx_weekend_gate_promql,
  )

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
  # Critical deviation rules threshold on breach age > 1h and then use
  # `for = "1m"` to smooth single-eval ruler glitches. Warning suppression
  # waits two extra evals after that same grace so severe fresh breaches still
  # send the warning page before the critical page takes over, without
  # resolving the warning before the critical rule can definitely fire.
  deviation_critical_suppression_seconds = 3780
  deviation_critical_active_promql = format(
    "(%s) > %d",
    local.deviation_critical_gate_promql,
    local.deviation_critical_suppression_seconds,
  )
  deviation_warning_active_promql              = "((mento_pool_deviation_ratio unless (${local.fx_weekend_suppressed_deviation_ratio_promql})) unless on(chain_id, pool_id, pair) (${local.deviation_critical_active_promql}))"
  deviation_warning_unavailable_active_promql  = "((((time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0) and on(chain_id, pool_id, pair) ((time() - mento_pool_deviation_breach_start) <= ${local.deviation_critical_suppression_seconds})) unless on(chain_id, pool_id, pair) mento_pool_deviation_ratio) unless (${local.fx_weekend_suppressed_breach_start_promql}))"
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
  #   - For Celo reserve-strategy pools, `rebalance_reason` OPTIONALLY appends
  #     ` Reserve Balance: X.XX <token>` when the firing pool's `pair` matches
  #     a USD-pegged stable we have Aegis coverage for (USDC / USDT / axlUSDC).
  #     The balance value is read from Aegis's existing per-token
  #     `${TOKEN}_balanceOf{owner="Reserve",chain="celo"}` series —
  #     production-stable for years and refreshed every 10s — rather than a
  #     metrics-bridge probe (the in-bridge enrichment shipped in PR #237
  #     failed in production with `[REBALANCE_PROBE_FAILED]: Missing or
  #     invalid parameters`, leaving the gauges absent, which propagated
  #     NoData through this rule and stuck the critical alerts in Normal for
  #     ~9h on 2026-04-28). Monad reserves aren't in Aegis yet — see the
  #     Aegis Monad coverage entry in BACKLOG.md.
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
  # Aegis-sourced reserve balances (ResUSDC / ResUSDT / ResAxlUSDC):
  #   - Read Aegis's existing `${TOKEN}_balanceOf{owner="Reserve",chain=
  #     "celo"}` series (production-stable for years; refreshed every 10s
  #     via Treb-driven RPC reads in the Aegis NestJS service).
  #   - Celo-only — Monad reserves aren't tracked in Aegis yet; future
  #     Monad-reserve breach annotations will lack the balance line until
  #     Aegis grows Monad coverage. Tracked in BACKLOG.md.
  #   - USDC / USDT / axlUSDC all expose 6dp on chain; `/ 1e6` normalises
  #     to human units so the template's `printf "%.2f"` renders in the
  #     same scale as the dashboard tooltip.
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
    {
      ref_id = "ResUSDC"
      expr   = "label_replace(USDC_balanceOf{owner=\"Reserve\", chain=\"celo\"} / 1e6, \"chain_name\", \"$1\", \"chain\", \"(.*)\") * on(chain_name) group_left(chain_id, pool_id, pair, pool_address_short, block_explorer_url, job, instance) (mento_pool_deviation_ratio{chain_name=\"celo\", pair=\"USDC/USDm\"} * 0 + 1)"
    },
    {
      ref_id = "ResUSDT"
      expr   = "label_replace(USDT_balanceOf{owner=\"Reserve\", chain=\"celo\"} / 1e6, \"chain_name\", \"$1\", \"chain\", \"(.*)\") * on(chain_name) group_left(chain_id, pool_id, pair, pool_address_short, block_explorer_url, job, instance) (mento_pool_deviation_ratio{chain_name=\"celo\", pair=\"USDT/USDm\"} * 0 + 1)"
    },
    {
      ref_id = "ResAxlUSDC"
      expr   = "label_replace(axlUSDC_balanceOf{owner=\"Reserve\", chain=\"celo\"} / 1e6, \"chain_name\", \"$1\", \"chain\", \"(.*)\") * on(chain_name) group_left(chain_id, pool_id, pair, pool_address_short, block_explorer_url, job, instance) (mento_pool_deviation_ratio{chain_name=\"celo\", pair=\"axlUSDC/USDm\"} * 0 + 1)"
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
    if contains(["B", "ResUSDC", "ResUSDT", "ResAxlUSDC"], query.ref_id)
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
