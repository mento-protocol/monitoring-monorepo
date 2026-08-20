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

resource "grafana_folder" "peg_monitoring" {
  for_each = local.peg_alert_instances

  title = "Peg Monitoring"
  uid   = "peg-monitoring"
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

resource "grafana_folder" "trading_modes" {
  title = "Trading Modes"
}

resource "grafana_folder" "trading_limits" {
  title = "Trading Limits"
}

locals {
  # Reserve and Aegis folders are owned outside this stack. Aegis pins its UID
  # in aegis/terraform/grafana-folders.tf; Reserve is an existing external
  # Grafana folder not yet owned by a Terraform stack. Keep their current UIDs
  # static so same-repo PR plans can target these rule groups without
  # authenticating live Grafana data sources.
  external_folder_uids = {
    reserve = "a87JaoO4k"
    aegis   = "fe2mj51r3ifwga"
  }

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
  oracle_timestamp_compat_promql      = "max without (last_oracle_update_url) (mento_pool_oracle_timestamp)"
  oracle_live_timestamp_compat_promql = "(mento_pool_oracle_live_timestamp or ${local.oracle_timestamp_compat_promql})"
  oracle_expiry_compat_promql         = "max without (last_oracle_update_url) (mento_pool_oracle_expiry)"
  # Age helpers intentionally repeat the timestamp expression in the guard and
  # fallback so annotation queries keep a label-matched `-1` sentinel for
  # never-reported pools without depending on a recording rule.
  oracle_timestamp_age_promql = format(
    "((time() - %s) and on(chain_id, pool_id, pair) (%s > 0)) or on(chain_id, pool_id, pair) (0 * %s - 1)",
    local.oracle_timestamp_compat_promql,
    local.oracle_timestamp_compat_promql,
    local.oracle_timestamp_compat_promql,
  )
  oracle_live_age_compat_promql = format(
    "((time() - %s) and on(chain_id, pool_id, pair) (%s > 0)) or on(chain_id, pool_id, pair) (0 * %s - 1)",
    local.oracle_live_timestamp_compat_promql,
    local.oracle_live_timestamp_compat_promql,
    local.oracle_live_timestamp_compat_promql,
  )
  oracle_expiry_duration_part_promql = {
    OracleExpiryDays    = format("floor((%s) / 86400)", local.oracle_expiry_compat_promql)
    OracleExpiryHours   = format("floor(((%s) %% 86400) / 3600)", local.oracle_expiry_compat_promql)
    OracleExpiryMinutes = format("floor(((%s) %% 3600) / 60)", local.oracle_expiry_compat_promql)
    OracleExpirySeconds = format("floor((%s) %% 60)", local.oracle_expiry_compat_promql)
  }
  oracle_age_duration_part_promql = {
    OracleAgeDays    = format("floor((%s) / 86400)", local.oracle_live_age_compat_promql)
    OracleAgeHours   = format("floor(((%s) %% 86400) / 3600)", local.oracle_live_age_compat_promql)
    OracleAgeMinutes = format("floor(((%s) %% 3600) / 60)", local.oracle_live_age_compat_promql)
    OracleAgeSeconds = format("floor((%s) %% 60)", local.oracle_live_age_compat_promql)
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

  # The warning tier now carries the whole deviation ladder, and nothing
  # suppresses it. Both expressions used to subtract the pools the
  # magnitude-based critical rules had taken over (`unless
  # deviation_critical_ready`). Those rules are gone — ADR 0067 moved paging
  # from deviation magnitude to depletion risk — so removing the suppression
  # branch with them is load-bearing, not cleanup: without it the pools that
  # were loudest under the old definition would get no notification at all.
  # Every pool outside the 1% tolerance now stays covered in #alerts-pools for
  # as long as its breach is open.
  deviation_warning_active_promql             = "(mento_pool_deviation_ratio unless (${local.fx_weekend_suppressed_deviation_ratio_promql}))"
  deviation_warning_unavailable_active_promql = "((time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_breach_start > 0) unless on(chain_id, pool_id, pair) mento_pool_deviation_ratio) unless (${local.fx_weekend_suppressed_breach_start_promql})"

  # ── Pool depletion risk ───────────────────────────────────────────────────
  # What makes a pool critical is user impact, not deviation magnitude. An
  # oracle-priced FPMM quotes the same price at 60/40 as at 50/50, so a wide
  # ratio costs a swapper nothing on its own. A side running dry does: once one
  # leg is empty every swap into that leg reverts, and well before that the
  # remaining bandwidth on that side is too thin to serve normal size.
  # `min(side share)` is that signal — measured by VALUE, not by token count.
  #
  # The count share (`mento_pool_reserve_share_token*`) is not a depletion
  # signal on a pair that does not trade near parity: it is dominated by the
  # exchange rate. A healthy, balanced JPYm/USDm pool reads 0.4% / 99.6% by
  # count purely because one JPY is worth ~0.0063 USD, and the first shipped
  # version of these rules (PR #1940) would have paged on both JPYm pools
  # forever. `mento_pool_reserve_value_share_token*` converts each leg through
  # the pool's own oracle reference — the same frame the FPMM contract and the
  # indexer's `priceDifference` use, including the per-pool `invertRateFeed`
  # orientation — so 50/50 here means "sitting on the oracle" and the floors
  # below read as economic one-sidedness.
  #
  # `min without(token_symbol)` folds the two flat per-token gauges into one
  # series per pool. Aggregation drops `__name__`, so the result carries
  # exactly the pool fingerprint (chain_id, pool_id, pair, …) that the alert
  # instances and the R0/R1 annotation queries are keyed on. Both gauges are
  # skipped when a pool's reserves are both zero, so an unfunded pool produces
  # no series and cannot fire either tier.
  #
  # The value gauges additionally need a live median and an on-chain-read feed
  # orientation, so a pool with a dark feed publishes neither and both tiers
  # evaluate NoData. `no_data_state = "OK"` on both rules makes that silence,
  # not a page: a dark oracle is what the oracle staleness rules are for, and
  # a depletion number derived from a stale or guessed rate would be worse
  # than none. Today that is the Polygon EURm/EUROP pool, which has never
  # landed a median; a feed that goes dark later drops out the same way,
  # because the bridge gates on the median being live and not merely on the
  # retained last price.
  #
  # Deliberately NOT FX-weekend gated, unlike the deviation rules above. Those
  # gate FX pairs because their signal derives from an oracle that legitimately
  # stops updating while the market is closed. Reserve share is on-chain
  # balances only: a pool that is 95/5 by value on Saturday genuinely cannot
  # serve one swap direction, and the weekend is exactly when nobody is
  # watching. The rate used to weight the legs is the last median, which on a
  # closed FX pair is Friday's — stale for pricing a trade, fine for deciding
  # whether the two legs are worth roughly the same. Same reasoning as the
  # un-gated Oracle Jump rules in rules-fpmms.tf.
  pool_min_reserve_value_share_promql = "min without(token_symbol) (mento_pool_reserve_value_share_token0 or mento_pool_reserve_value_share_token1)"
  # Rendered as percentages for the annotations, which name the thin side and
  # the number an operator will quote back. Value shares, so the number in
  # Slack is the same one that decided the alert.
  pool_depletion_value_share_annotation_queries = [
    {
      ref_id = "V0"
      expr   = "mento_pool_reserve_value_share_token0 * 100"
    },
    {
      ref_id = "V1"
      expr   = "mento_pool_reserve_value_share_token1 * 100"
    },
  ]
  # Two mutually exclusive bands, same shape as the oracle-jump tiers: a pool
  # matches the page rule or the critical rule, never both, so one depleting
  # pool never produces two notifications. The page band is open-ended
  # downward (a fully drained 0% side still pages); the critical band is
  # floored at the page share here and capped by its own Grafana evaluator.
  pool_depletion_page_active_promql     = local.pool_min_reserve_value_share_promql
  pool_depletion_critical_active_promql = "(${local.pool_min_reserve_value_share_promql}) >= 0.1"

  # ── Value-share coverage gap ─────────────────────────────────────────────
  # Both bands above read the VALUE-share gauges, which the bridge publishes
  # only for a pool with a live median AND an on-chain-read `invertRateFeed`
  # orientation. That gate is fail-closed and correct — a depletion number
  # derived from a guessed orientation would be worse than none — but it is
  # silent: a pool that trips it leaves both bands at NoData, and `no_data_state
  # = "OK"` turns that into no notification at all. This expression is the
  # visibility companion, the same unless-shape as
  # `deviation_warning_unavailable_active_promql` above, which covers the
  # matching data-unavailable gap on the deviation side.
  #
  # Left side — pools the bridge sees holding reserves. The count-share gauges
  # publish whenever normalized reserves sum above zero, so their presence is
  # exactly "this pool is funded" and needs no separate reserves metric.
  #
  # `max`, not `min`: on a fully one-sided pool the thin side reads 0.0, and a
  # `> 0` threshold would then skip the pool with the WORST depletion exposure.
  # The fat side is >= 0.5 for any funded pool, so `max` fires for every funded
  # pool, and the value it fires with reads as the concentration on the heavy
  # leg. The alert is a presence signal; the number is diagnostic only.
  #
  # `without(token_symbol)` folds the two flat per-token series into one series
  # per pool and drops `__name__`, leaving exactly the pool fingerprint the
  # alert instances and the `notify_warning_pools_pool` `group_by` are keyed on
  # — same reason `pool_min_reserve_value_share_promql` aggregates that way.
  #
  # Right side — `unless on(chain_id, pool_id, pair)`, not a bare `unless`: the
  # value gauges carry `token_symbol` and their own `__name__`, so a full
  # label-set comparison would never match and the rule would fire on every
  # funded pool. `on()` restricts the join to the pool fingerprint the two
  # gauge families share.
  pool_value_share_missing_active_promql = "max without(token_symbol) (mento_pool_reserve_share_token0 or mento_pool_reserve_share_token1) unless on(chain_id, pool_id, pair) (mento_pool_reserve_value_share_token0 or mento_pool_reserve_value_share_token1)"

  # Transition markers let resolved notifications say why an alert stopped
  # instead of listing every possible cause. Each base alert rule adds the
  # matching query as annotation-only `Info`; it is not part of the threshold
  # condition. Grafana can mark the whole rule NoData when an annotation query
  # returns zero series, so each `Info` query falls back to a zero-valued series
  # matching the base alert's own active label set. The transition marker wins
  # when present and carries the reason labels; the fallback only keeps active
  # alerts evaluable between transitions.
  deviation_warning_resolved_transition_promql             = "mento_pool_deviation_alert_transition_active{from=\"warning\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0"
  deviation_warning_unavailable_resolved_transition_promql = "mento_pool_deviation_alert_transition_active{from=\"deviation_ratio_unavailable_warning\",reason!~\"breach_started|state_changed|fx_weekend_reopened\"} > 0"
  deviation_warning_resolved_info_promql                   = "(${local.deviation_warning_resolved_transition_promql}) or on(chain_id, pool_id, pair) (0 * (${local.deviation_warning_active_promql}))"
  deviation_warning_unavailable_resolved_info_promql       = "(${local.deviation_warning_unavailable_resolved_transition_promql}) or on(chain_id, pool_id, pair) (0 * (${local.deviation_warning_unavailable_active_promql}))"

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
  #   - `deviation_warning_summary_annotation` reads `$values.Dev.Value` from a
  #     query that pre-computes `(mento_pool_deviation_ratio - 1) * 100` in
  #     PromQL, and its duration from `$values.BreachAge`. Rendering branches
  #     by magnitude so summaries stay scannable across four orders of
  #     magnitude ("Pool 5% above…" → "Pool 44M% above…"):
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
  #     NoData through the deviation rules and stuck them in Normal for
  #     ~9h on 2026-04-28).
  #   - `pool_depletion_summary_annotation` names the depleting side from the
  #     V0/V1 value-share queries — not R0/R1, which are token counts and on an
  #     off-parity pair name the wrong side. Whichever value share is smaller is
  #     the leg that runs out first, and its `token_symbol` label is the token
  #     swappers will stop being able to buy. The `$values.A` fallback renders
  #     the aggregated min value share through `humanizePercentage` — safe here
  #     because A is a [0, 1] fraction, nowhere near the 1e4 regime where that
  #     helper flips to scientific notation.
  deviation_warning_summary_annotation = <<-EOT
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
  # One summary for both depletion tiers. The rule names ("Pool Depletion
  # Risk" / "Pool Nearly One-Sided") carry the severity distinction, so the
  # copy only has to answer the two operator questions: which side is running
  # out, and what to check.
  pool_depletion_summary_annotation = <<-EOT
    {{- if and $values.V0 $values.V1 -}}
      {{- if lt $values.V0.Value $values.V1.Value -}}
        {{- printf "Only %.0f%% of pool value is %s. Users cannot swap into %s once that side empties — check the rebalancer and %s reserve bandwidth." $values.V0.Value $values.V0.Labels.token_symbol $values.V0.Labels.token_symbol $values.V0.Labels.token_symbol -}}
      {{- else -}}
        {{- printf "Only %.0f%% of pool value is %s. Users cannot swap into %s once that side empties — check the rebalancer and %s reserve bandwidth." $values.V1.Value $values.V1.Labels.token_symbol $values.V1.Labels.token_symbol $values.V1.Labels.token_symbol -}}
      {{- end -}}
    {{- else if $values.A -}}
      {{- printf "Smallest pool side holds only %s of pool value. Users cannot swap into it once it empties — check the rebalancer and reserve bandwidth." (humanizePercentage $values.A.Value) -}}
    {{- else -}}
      One pool side is nearly drained. Users cannot swap into it once it empties — check the rebalancer and reserve bandwidth.
    {{- end -}}
  EOT
  # Depletion-only companion to `current_reserves`. The two lines answer
  # different questions and can look contradictory on an off-parity pair by
  # design: a balanced JPYm/USDm pool is "0% USDm / 100% JPYm" by token count
  # and "40% USDm / 60% JPYm" by value. The alert fires on the value line, so
  # it says so in words rather than leaving on-call to guess which number the
  # threshold used.
  pool_depletion_value_composition_annotation     = <<-EOT
    {{- if and $values.V0 $values.V1 -}}
      {{- printf "%.0f%%" $values.V0.Value }} {{ $values.V0.Labels.token_symbol }} / {{ printf "%.0f%%" $values.V1.Value }} {{ $values.V1.Labels.token_symbol }} (value-weighted share, at the last oracle median)
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
  # ResUSDC / ResUSDT0 / ResAUSD on Monad; ResUSDC on Polygon —
  # issue #707):
  #   - Read Aegis's `${TOKEN}_balanceOf{owner="Reserve"}` series, one per
  #     chain via the `chain` label (production-stable for years on Celo;
  #     refreshed every 10s via Treb-driven RPC reads in the Aegis NestJS
  #     service).
  #   - ResUSDC is chain-agnostic (USDC/USDm exists on all production pool
  #     chains); ResUSDT / ResAxlUSDC are Celo-only and ResUSDT0 / ResAUSD are
  #     Monad-only, so each binds to its own chain's pool instances via the
  #     `on(chain_name)` join.
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
    # ResUSDC is chain-AGNOSTIC: USDC/USDm pools exist on Celo, Monad, and Polygon.
    # Both operands omit a chain pin so `label_replace(...) * on(chain_name)
    # group_left(...)` produces one balance row per chain, each
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
