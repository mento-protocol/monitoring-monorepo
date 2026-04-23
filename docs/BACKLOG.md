# Monitoring Monorepo — Task Backlog

Last updated: 2026-04-23

## Next — v3 Alerting

Metrics pipeline is **live end-to-end**: `metrics-bridge` (Cloud Run in the `mento-monitoring` GCP project) → Grafana Agent (`mento-prod` App Engine) → Grafana Cloud Prometheus (`clabsmento.grafana.net`). 11 FPMM pools across Celo + Monad mainnet reporting every 30s, `mento_pool_bridge_last_poll` staying under ~30s stale. Remaining work is defining alert rules in Terraform and wiring the Slack contact point.

### Blocking / coordination

- [ ] **Slack `#alerts-v3` channel + webhook** — create channel, add Grafana Cloud incoming webhook integration, stash the URL as `TF_VAR_slack_webhook_alerts_v3` (repo secret + local env). Naming is `#alerts-v3` (not `-pools`) so `oracles` / `cdps` / `metrics-bridge` alerts land in the same channel.

### v3 Alert Rules — first-cut, to land in `terraform/alerts/`

Each rule attaches a `service` label (drives notification-policy routing to Slack). Convention: `service` = monitored domain (matches the existing Aegis pattern of `oracle-relayers` / `trading-limits` / `reserve` — narrow, per alert category, not per producer):

- [ ] `service=fpmms` — **Oracle liveness on pool** — warn on live-ratio >0.8 (`(time() - mento_pool_oracle_timestamp) / mento_pool_oracle_expiry`), critical on `mento_pool_oracle_ok == 0`.
- [ ] `service=fpmms` — **Deviation breach** — warn on `mento_pool_deviation_ratio > 1` OR `mento_pool_deviation_breach_start > 0`. Critical when the breach has persisted >60min (`time() - mento_pool_deviation_breach_start > 3600`). Indexer anchors the grace-window timestamp.
- [ ] `service=fpmms` — **Trading limit pressure** — warn on `max(mento_pool_limit_pressure) > 0.8`, critical on `>= 1`.
- [ ] `service=fpmms` — **Rebalancer stale** — critical when deviation has been breaching for >30min AND `mento_pool_last_rebalanced_at` older than 30min (i.e. the on-chain rebalancer hasn't taken action under pressure).
- [ ] `service=metrics-bridge` — **Bridge not reporting** — critical if `time() - mento_pool_bridge_last_poll > 90` (3x the 30s poll interval) OR `rate(mento_pool_bridge_poll_errors_total[5m]) > 0`.

### Reserved `service` values (future work, not in first PR)

- `service=oracles` — oracle report quality (large deltas, outlier detection). Distinct from Aegis's existing `oracle-relayers` which monitors relayer liveness, not report content.
- `service=cdps` — CDP / stability-pool / liquidity alerts once the indexer tracks them (blocked on Liquity v2 indexing).

All four values route to `#alerts-v3` via a single notification-policy regex match `service =~ "fpmms|oracles|cdps|metrics-bridge"`. Split later by severity or add per-domain channels without relabelling series.

### Infrastructure

- [x] **GCP project `mento-monitoring`** — bootstrapped via terraform, org-level SA granted owner on new project (PRs #197 terraform-owner-bootstrap)
- [x] **Cloud Run `metrics-bridge`** — 512Mi mem, `cpu_idle=false`, `/health` probe path (Cloud Run v2 reserves `/healthz` at the frontend)
- [x] **Workload Identity Federation** for CI deploys — no long-lived keys (PR #200)
- [x] **Image rollouts out of Terraform** — `lifecycle.ignore_changes` on image, `gcloud run services update` drives rollouts, `--revision-suffix=<sha>-<run-id>` makes rollbacks self-describing (PR #201)
- [x] **Per-chain Hasura URL consolidation** — single `NEXT_PUBLIC_HASURA_URL`; dropped hosted testnet network entries (PR #195)
- [x] **Grafana Agent scrape target** — `grafana-agent/agent.yaml.tmpl` polls `metrics-bridge-pxlhqhqvxq-ew.a.run.app/metrics` every 30s (aegis PR #48)
- [x] **Grafana Agent container hardening chain** — four latent breakages from aegis #47 surfaced in order: Alpine→Debian commands (#51), UID/GID 1000 collision (#52), deprecated `server:` YAML block (#53), WAL-dir permissions under non-root user (#54)

### Out of scope for first PR

- [ ] **Stability Pool headroom alert** — blocked on Liquity v2 CDP indexing (see below)

---

## Backlog — Indexer Enhancements

- [ ] **Liquity v2 CDP indexing**
  - TroveManager events: `TroveOpened`, `TroveClosed`, `TroveUpdated`, `LiquidationEvent`
  - StabilityPool events: `UserDepositChanged`, `PoolBalanceUpdated`
  - Contracts: TroveManager `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9`, StabilityPool `0x06346c0fAB682dBde9f245D2D84677592E8aaa15`
  - New entities: `Trove`, `StabilityPoolSnapshot`
- [ ] **Monad indexing** — config ready, contracts deployed
- [ ] **ChainStat / GlobalStat** — protocol-level aggregate entity (total pools, total swaps, global TVL)

## Backlog — Dashboard

- [ ] **Gap-fill for snapshot charts** — forward-fill missing hourly buckets in dashboard layer

## Backlog — Future

- [ ] **Streamlit sandbox** — Python/Streamlit reads same Hasura backend
- [ ] **ClickHouse sink** — heavy analytics beyond Postgres

## Tech Debt

- [ ] Dashboard component test coverage (71 test files total, but many are lib/util — component tests sparse)
- [ ] Revenue page placeholders ("CDP Borrowing Fees" and "Reserve Yield" marked "Soon")

---

## Done

### Indexer

- [x] Envio indexer for Celo Sepolia (VirtualPools + FPMMs)
- [x] Envio indexer for Celo Mainnet (4 FPMMs: USDm/GBPm, USDm/axlUSDC, USDm/USDC, USDT/USDm)
- [x] Envio hosted deployment: `mento-v3-celo-mainnet` live, 100% synced
- [x] Envio hosted deployment: `mento-v3-celo-sepolia` live
- [x] Oracle health state (`healthStatus`, `oracleOk`, `oraclePrice`, `priceDifference`, `rebalanceThreshold`)
- [x] OracleSnapshot entity — per-event oracle price + health timeline
- [x] SortedOracles event indexing (mainnet only)
- [x] TradingLimit entity (`limitStatus`, `limitPressure0/1`, `netflow0/1`, `limit0/1`)
- [x] Rebalancer liveness (`rebalancerAddress`, `rebalanceLivenessStatus`, `effectivenessRatio`)
- [x] PoolSnapshot pre-aggregation (volume, TVL, fees per pool per hour)
- [x] PoolDailySnapshot rollup (daily aggregation)
- [x] Pool cumulative fields (`swapCount`, `notionalVolume0/1`, `rebalanceCount`)
- [x] Deviation breach tracking (`deviationBreachStartedAt` on Pool)
- [x] FX weekend exclusion from healthscore math
- [x] FX calendar extracted to `shared-config` package
- [x] Multichain config (`config.multichain.mainnet.yaml` — Celo + Monad)
- [x] `txHash` on all events, `@index` directives for query performance
- [x] Multichain config: `config.multichain.mainnet.yaml`, `config.multichain.testnet.yaml`
- [x] Deploy branch strategy (`deploy/celo-mainnet`, `deploy/celo-sepolia`)
- [x] Token addresses sourced from `@mento-protocol/contracts`
- [x] Retry + fallback RPC on rate limit and block-out-of-range errors

### Dashboard

- [x] Live at monitoring.mento.org
- [x] Global overview page (`/`) — metrics tiles, all pools table, activity ranking
- [x] Pool detail page (`/pools/[poolId]`) — trades, reserve chart, analytics tab
- [x] Oracle health: HealthBadge, HealthPanel, OracleChart (dual y-axis)
- [x] Analytics tab with PoolSnapshot charts
- [x] Fully multichain — network switcher dropped, chain icon prefix on pool IDs
- [x] Token symbol mapping, `isFpmm()` in `tokens.ts`
- [x] Shared `PoolsTable` component
- [x] LimitBadge + LimitPanel (trading limit pressure per token)
- [x] RebalancerBadge + RebalancerPanel (liveness status + diagnostics)
- [x] TVL on global page — TVL-over-time chart + tiles with 24h/7d/30d change %
- [x] TVL Δ WoW column on all pools table
- [x] Protocol Revenue page (`/revenue`) — swap fee time-series
- [x] Daily volume chart on pool detail
- [x] Error boundaries + loading skeletons (route-level)
- [x] Google Auth (NextAuth.js — `@mentolabs.xyz` only)

### Infrastructure (Done)

- [x] Monorepo extraction from devnet repo
- [x] CI: ESLint 10 + Vitest (71 test files) + typecheck + Codecov
- [x] `pnpm deploy:indexer [network]` (prompts if no network passed)
- [x] `pnpm update-endpoint:mainnet` — Vercel env var update after indexer redeploy
- [x] Discord notification on deploy branch push (`notify-envio-deploy.yml`)
- [x] Deployment docs (`docs/deployment.md`)
- [x] Non-interactive deploy scripts (status, promote, logs)

### Alerting (Aegis v2 — live)

- [x] Aegis NestJS service on GCP App Engine — polls v2 contract state via RPC
- [x] Grafana Agent on GCP → pushes Prometheus metrics to Grafana Cloud
- [x] Grafana dashboard: "Aegis — On-chain Metrics"
- [x] Alert rules: oracle relayers (stale feeds, low CELO balance)
- [x] Alert rules: reserve balances (low USDC/USDT/axlUSDC)
- [x] Alert rules: trading modes (circuit breakers tripped)
- [x] Alert rules: trading limits (L0/L1/LG utilization >90%)
- [x] Alert rules: Aegis service health (RPC failures, data staleness)
- [x] Contact points: 8 Discord webhooks + Splunk On-Call
- [x] Notification policies with severity-based routing
- [x] Weekend mute timings for FX rate feeds
- [x] All Grafana config Terraform-managed
