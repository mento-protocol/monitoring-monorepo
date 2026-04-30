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

  # ── Deviation Breach Critical annotations ────────────────────────────────
  # Both critical deviation-breach rules (magnitude-gated and anchored)
  # render the same Slack diagnostic lines, so we author them once here.
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
  #   - `current_deviation` reads `$values.Dev.Value` from a query that
  #     pre-computes `(mento_pool_deviation_ratio - 1) * 100` in PromQL.
  #     `printf "%.0f%%"` renders the integer percent (e.g. `12.19` → "12%").
  #     We avoid `humanizePercentage` here because its `%.4g` format flips
  #     to scientific notation above 1e4 — a 122x breach (deviation ratio
  #     123.19) would render "1.219e+04% above threshold" instead of
  #     "12190% above threshold". The smallest meaningful breach magnitude
  #     gated by this alert is 5%, so `%.0f` is plenty of resolution.
  #   - `current_reserves` reads `$values.R0.Value` / `$values.R1.Value`
  #     (already in [0, 1]) plus `.Labels.token_symbol` from each series
  #     to render "axlUSDC / USDm". Map access is a Go template builtin.
  #   - `humanizePercentage` on values like `0.5` renders "50%". For
  #     values < 0.005 (rounding to "0%") this still passes the diagnostic
  #     "100% USDT / 0% USDm" intent — small-share legs are functionally
  #     drained. (Reserves are by-construction in [0, 1] so the scientific-
  #     notation path that bit `current_deviation` doesn't apply here.)
  #   - `rebalance_reason` reads `$values.B.Labels.{reason_message,reason_code}`
  #     for the bounded Solidity-error explanation, then OPTIONALLY appends
  #     `· Reserve balance: X.XX <token> (via Aegis)` when the firing
  #     pool's `pair` matches a USD-pegged stable we have Aegis coverage
  #     for (USDC / USDT / axlUSDC, all on Celo). The balance value is
  #     read from Aegis's existing per-token `${TOKEN}_balanceOf{owner=
  #     "Reserve", chain="celo"}` series — production-stable for years and
  #     refreshed every 10s — rather than a metrics-bridge probe (the
  #     in-bridge enrichment shipped in PR #237 failed in production with
  #     `[REBALANCE_PROBE_FAILED]: Missing or invalid parameters`, leaving
  #     the gauges absent, which propagated NoData through this rule and
  #     stuck the critical alerts in Normal for ~9h on 2026-04-28).
  #     Monad reserves aren't in Aegis yet — see the Aegis Monad coverage
  #     entry in BACKLOG.md.
  deviation_critical_current_deviation_annotation = "{{ if $values.Dev }}{{ printf \"%.0f%%\" $values.Dev.Value }} above threshold{{ end }}"
  deviation_critical_current_reserves_annotation  = "{{ if and $values.R0 $values.R1 }}{{ humanizePercentage $values.R0.Value }} {{ $values.R0.Labels.token_symbol }} / {{ humanizePercentage $values.R1.Value }} {{ $values.R1.Labels.token_symbol }}{{ end }}"
  # HEREDOC keeps the multi-branch template legible — `{{-`/`-}}` whitespace
  # trim markers strip ALL surrounding whitespace (including newlines), so
  # the output collapses to a single line at render time.
  #
  # Branches:
  #   - outer `{{ if $values.B }}` — guards on the rebalance-blocked gauge
  #     producing a series at all (probe didn't run / RPC down → no
  #     annotation line).
  #   - middle `{{ if and $rm $rc }}` — both labels are 1:1 with the gauge
  #     by construction; the nil-and-emptystring guard is defensive against
  #     a misconfigured probe writing only one half. Renders the standard
  #     "<reason_message> — [<reason_code>]" tag.
  #   - inner Aegis dispatch — each ResX query is already pair-scoped via
  #     the cross-join (pair="USDC/USDm" etc.), so only the matching pool
  #     instance sees a non-nil $values.ResX. The chain/pair guards here
  #     are defensive but harmless. New stable pairs need both an Aegis
  #     Treb source and a new branch here + a new cross-join query.
  deviation_critical_rebalance_reason_annotation = <<-EOT
    {{- if $values.B -}}
      {{- $rm := index $values.B.Labels "reason_message" -}}
      {{- $rc := index $values.B.Labels "reason_code" -}}
      {{- if and $rm $rc -}}
        {{- $rm }} — [{{ $rc }}]
        {{- $pair := index $labels "pair" -}}
        {{- $chain := index $labels "chain_name" -}}
        {{- if and (eq $chain "celo") (eq $pair "USDC/USDm") $values.ResUSDC -}}
          {{ " · Reserve balance: " }}{{ printf "%.2f" $values.ResUSDC.Value }} USDC (via Aegis)
        {{- else if and (eq $chain "celo") (eq $pair "USDT/USDm") $values.ResUSDT -}}
          {{ " · Reserve balance: " }}{{ printf "%.2f" $values.ResUSDT.Value }} USDT (via Aegis)
        {{- else if and (eq $chain "celo") (eq $pair "axlUSDC/USDm") $values.ResAxlUSDC -}}
          {{ " · Reserve balance: " }}{{ printf "%.2f" $values.ResAxlUSDC.Value }} axlUSDC (via Aegis)
        {{- end -}}
      {{- end -}}
    {{- end -}}
  EOT

  # ── Deviation Breach Critical annotation-only data sources ───────────────
  # Both critical rules (magnitude-gated + anchored) wire the same instant
  # queries into `$values.*` so the annotation locals above can render.
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
  deviation_critical_annotation_queries = [
    {
      ref_id = "Dev"
      expr   = "(mento_pool_deviation_ratio - 1) * 100"
    },
    {
      ref_id = "R0"
      expr   = "mento_pool_reserve_share_token0"
    },
    {
      ref_id = "R1"
      expr   = "mento_pool_reserve_share_token1"
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

  # ── Oracle Jump Critical annotation-only data sources ─────────────────────
  # Annotation queries for the `Oracle Jump Far Above Swap Fee` rule, fed
  # into the rule's `dynamic "data"` block. Same pattern as
  # `deviation_critical_annotation_queries` above — kept out of the threshold
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
