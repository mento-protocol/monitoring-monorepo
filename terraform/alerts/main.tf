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
  #     `". Current balance: X token / Needed for rebalancing: Y token"`
  #     when the reserve-collateral enrichment is present (RLS reverts only,
  #     emitted by the metrics-bridge probe). `printf "%.2f"` keeps the
  #     output deterministic across magnitudes; `Bal.Labels.token_symbol`
  #     names the collateral. When the reserve-enrichment gauges are absent
  #     (every other reason code, transport errors, non-reserve strategies)
  #     the inner guard collapses and the line keeps the historical shape:
  #     "<reason_message> — [<reason_code>]".
  deviation_critical_current_deviation_annotation = "{{ if $values.Dev }}{{ printf \"%.0f%%\" $values.Dev.Value }} above threshold{{ end }}"
  deviation_critical_current_reserves_annotation  = "{{ if and $values.R0 $values.R1 }}{{ humanizePercentage $values.R0.Value }} {{ $values.R0.Labels.token_symbol }} / {{ humanizePercentage $values.R1.Value }} {{ $values.R1.Labels.token_symbol }}{{ end }}"
  # Three-level nested guard — single-string form was 600+ chars and hard
  # to audit visually. HEREDOC preserves the byte-identical rendered output
  # via `{{-`/`-}}` whitespace trim markers (they strip ALL surrounding
  # whitespace including the newline), so the output collapses to one line
  # at render time exactly as before. The leading `{{- end }}` line of the
  # heredoc is trimmed away by the template engine, leaving no trailing
  # newline.
  #
  # Branches:
  #   - outer `{{ if $values.B }}` — guards on the rebalance-blocked gauge
  #     producing a series at all (probe didn't run / RPC down → no
  #     annotation line).
  #   - middle `{{ if and $rm $rc }}` — both labels are 1:1 with the gauge
  #     by construction; the nil-and-emptystring guard is defensive against
  #     a misconfigured probe writing only one half.
  #   - inner `{{ if and $values.Bal $values.Need }}` — Reserve enrichment
  #     present (RLS_RESERVE_OUT_OF_COLLATERAL only) → render symbol + balance.
  #     Else branch falls through to "[reason_code]" tag for non-reserve
  #     reasons, preserving the historical shape.
  deviation_critical_rebalance_reason_annotation = <<-EOT
    {{- if $values.B -}}
      {{- $rm := index $values.B.Labels "reason_message" -}}
      {{- $rc := index $values.B.Labels "reason_code" -}}
      {{- if and $rm $rc -}}
        {{- $rm -}}
        {{- if and $values.Bal $values.Need -}}
          . Current balance: {{ printf "%.2f" $values.Bal.Value }} {{ $values.Bal.Labels.token_symbol }} / Needed for rebalancing: {{ printf "%.2f" $values.Need.Value }} {{ $values.Bal.Labels.token_symbol -}}
        {{- else -}}
          {{ " — [" }}{{- $rc -}}{{ "]" }}
        {{- end -}}
      {{- end -}}
    {{- end -}}
  EOT

  # ── Deviation Breach Critical annotation-only data sources ───────────────
  # Both critical rules (magnitude-gated + anchored) wire the same six
  # instant queries into `$values.{Dev,R0,R1,B,Bal,Need}` so the annotation
  # locals above can render. Authored once here and consumed by `dynamic`
  # blocks in `rules-fpmms.tf` so a query-shape change (new annotation,
  # different time range) lands in one place. Keeping the list ordered:
  # condition gauges first (Dev/R0/R1, used by current_deviation +
  # current_reserves), then enrichment gauges (B/Bal/Need, used by
  # rebalance_reason). The threshold node is rule-specific (warning has a
  # different bound than critical), so it stays inline in each rule.
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
      ref_id = "Bal"
      expr   = "mento_pool_rebalance_collateral_balance"
    },
    {
      ref_id = "Need"
      expr   = "mento_pool_rebalance_collateral_needed"
    },
  ]
}
