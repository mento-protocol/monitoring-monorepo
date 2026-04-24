# PR Checklist — Grafana alerts / PromQL

Run this before opening or updating a PR that edits anything under `terraform/alerts/`. These gates come from real issues caught by Codex + Cursor reviewers on PR #221 (2026-04-24) and earlier alerting PRs.

## `pair` label filters need a structural guard

If your PromQL negates or matches on the `pair` label (e.g. `pair!~"<usd_pegged>"`), add `pair=~".+/.+"` as an AND-guard.

**Why:** `metrics-bridge/src/metrics.ts` falls back `pair = pool.id` (e.g. `"42220-0xabc…"`) when token symbol derivation fails. A raw negated regex will match these structurally-invalid labels, so an unmapped pool gets silently treated as "not in the matched set" and can be included or excluded wrongly. The `.+/.+` guard requires a well-formed `token0/token1` label before we act on it.

```
unless (mento_pool_oracle_timestamp{pair!~"<usd_pegged>",pair=~".+/.+"} and on() <gate>)
```

## USD-pegged / FX symbol set must be synced across tokens.ts and Terraform

- Source-of-truth list: `ui-dashboard/src/lib/tokens.ts` → `USD_PEGGED_SYMBOLS`
- Terraform mirror: `terraform/alerts/main.tf` → `usd_pegged_symbols_regex_part`
- Real-label fixture: `shared-config/__tests__/fixtures/known-pools.json` → `expectedLabel`

Both files carry cross-reference comments. When you add a new USD-pegged symbol (e.g. `USDT0`, `USD₮`) to one, grep the others and update.

## Pool-scoped vs service-scoped `notification_settings`

`notify_*_pool` drops `alertname` from `group_by` so co-firing KPI rules on the same pool collapse into one Slack thread. Non-pool rules (metrics-bridge, service-scoped) must use `notify_*` (with `alertname`) — otherwise they collapse into one folder-level group and distinct alertnames merge together silently.

Rule of thumb:

- Rule emits pool-level labels (`chain_id`, `pool_id`)? → use `local.notify_*_pool`
- Rule doesn't? → use `local.notify_*`

## Slack title template handles empty alertname

When multiple distinct `alertname`s group together (pool-scoped rules firing on the same pool), `{{ .CommonLabels.alertname }}` is empty. The title must fall back gracefully:

```go
{{ if .CommonLabels.alertname }}{{ .CommonLabels.alertname }}{{ else }}{{ len .Alerts }} alerts{{ end }}
```

Regression check: if you touch `contact-points.tf` title templates, simulate a 2-alertname group (e.g. Deviation Breach + Rebalancer Stale on the same pool) mentally before pushing.

## Verify the backup rule before gating a critical

If your change adds a time-window gate (FX weekend, maintenance window, etc.) to a critical rule, confirm that the "backup" signal you're relying on actually transitions cleanly under real stale conditions.

Known gap: `Pool.oracleOk` is only set `true` in SortedOracles handlers (`indexer-envio/src/handlers/sortedOracles.ts`) and never transitions back to `false`, so `Oracle Down` (`oracle_ok < 0.5`) only fires for never-reported pools. This is tracked in `docs/BACKLOG.md` under Indexer Enhancements. If you gate a critical and assume `Oracle Down` covers weekends/maintenance, you're almost certainly wrong until that backlog item lands.

## Duplicated subexpressions

Avoid re-evaluating the same ratio / rate expression twice inside an `unless` clause. Extract to a shared `locals` variable or use a cheaper selector (like `mento_pool_oracle_timestamp` instead of the ratio) for the unless match.
