# Monitoring Monorepo — Task Backlog

Last updated: 2026-04-24

## Next — Indexer: CDP strategy entity

Dashboard currently detects CDP-backed FPMMs via a runtime RPC probe (`ui-dashboard/src/lib/strategy-detection.ts`, added in PR #214). The indexer has all the data — the strategy is set via `LiquidityStrategyUpdated` and the `CDPLiquidityStrategy` address is recoverable — so this belongs in the schema.

- [ ] **New `CdpPool` entity** — mirror the `OlsPool` pattern (one-per-pool-with-a-CDP-strategy), registered on `LiquidityStrategyUpdated` when the configured strategy resolves to a `CDPLiquidityStrategy`.
- [ ] **Dashboard cutover** — replace `detectProbedStrategies()` with `ALL_CDP_POOLS` + `ALL_RESERVE_POOLS` GraphQL queries, delete the RPC probe module. See `TODO(cdp-indexer)` in the stopgap.

Touchpoints: `indexer-envio/schema.graphql`, handler in `indexer-envio/src/handlers/fpmm.ts:887`, dashboard replaces `strategy-detection.ts`.

---

## Backlog — Indexer Enhancements

- [ ] **Liquity v2 CDP indexing** — unblocks `service=cdps` stability-pool alerts + the Liquity v2 dashboard instance (spec §4 "Liquity v2 instance")
  - Events: TroveManager (`TroveOpened`, `TroveClosed`, `TroveUpdated`, `LiquidationEvent`), StabilityPool (`UserDepositChanged`, `PoolBalanceUpdated`)
  - Contracts: TroveManager `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9`, StabilityPool `0x06346c0fAB682dBde9f245D2D84677592E8aaa15`
  - New entities: `Trove` (per-CDP ICR snapshot + status), `StabilityPoolSnapshot`, `LiquityInstanceSnapshot` (one per instance, rolled hourly like `PoolSnapshot`)
  - Required latest-value metrics (spec §2): `spDepositsGbpm`, `spCollUsdM`, `spMinBufferGbpm`, `spHeadroomGbpm` (= deposits − minimum buffer), `systemColl`, `systemDebt`, `tcr`, `redemptionRate`
  - Required ICR distribution (spec §2): `icrP1`, `icrP5`, `icrP50`, `icrFracBelowMcr`. Not free from the event stream — needs a per-Trove scan at rollup time (or a sorted-insert index keyed by ICR so percentiles are O(1))
  - Required cumulative-since-T0 (spec §2): `liqCountCum`, `liqVolumeCum`, `redemptionCountCum`, `redemptionVolumeCum`
  - Minimum-buffer source: Liquity v2 config read — `spMinBufferGbpm` isn't event-sourced, needs periodic contract view call or a config snapshot entity
- [ ] **`turnoverCum` per pool** — cumulative `notionalCum / time-weighted-avg(tvlUsdM)` since T0 (spec §2). We track `notionalVolume0/1` but never compute time-weighted TVL; needs a TWAP-style accumulator on `Pool` updated on every reserves change (∑ tvl·dt, ∑ dt)
- [ ] **`timeInWarnCum` per pool** — cumulative seconds spent in warn (deviation breach inside grace window, pre-critical) since T0. Mirror the existing critical rollup (`Pool.cumulativeCriticalSeconds`, which already covers `timeInCriticalCum`); requires tracking warn-state transitions the same way `DeviationBreach` tracks critical
- [ ] **ChainStat / GlobalStat** — protocol-level aggregate entity (total pools, total swaps, global TVL, `chainProtocolFeesCum` / `globalProtocolFeesCum` from spec §2)
- [ ] **Oracle report history** — surface historical oracle prices on the indexer so `service=oracles` outlier alerts become expressible (consecutive-report deltas)
- [ ] **`lastOracleUpdateTxHash` on `Pool`** — unblocks the oracle tx-link tech-debt item (see below)

## Backlog — Dashboard

- [ ] **Gap-fill for snapshot charts** — forward-fill missing hourly buckets in dashboard layer
- [ ] **Pool detail config snapshot panel** (spec §4 "Pool") — consolidated view of configured thresholds: `rebalanceThreshold`, oracle expiry / `oracleNumReporters`, trading-limit windows (`limit0/1`, L0/L1/LG timers), rebalancer address. Today these are scattered across status panels or only visible via Etherscan. A single "Config" panel on pool detail makes a pool's configured shape auditable at a glance.

## Backlog — Infrastructure

- [ ] **Migrate Aegis into the monorepo** — Aegis (v2 alerting NestJS service + Grafana alert rules + dashboards) lives in a sibling repo today (`../aegis/`). Merging it into `monitoring-monorepo` removes cross-repo coordination for scrape-config edits, unifies the Terraform state layout (Aegis TF already shares `clabsmento.grafana.net` with `terraform/alerts/`), and lets `shared-config/` be a first-class dependency rather than a published package. Plan: pull `aegis/` under `services/aegis/`, fold `aegis/terraform/grafana-alerts` + `grafana-dashboard` into this repo's `terraform/` module tree, keep `aegis/grafana-agent/` until the Alloy migration (see below), and retire the aegis repo once App Engine deploys run from monorepo CI.
- [ ] **Grafana Agent → Grafana Alloy migration** — Grafana Agent reached EOL on 2025-11-01 and is already deprecated; Grafana Alloy is the OTel-collector-based successor. Today the Agent runs on App Engine in `mento-prod` (config at `../aegis/grafana-agent/agent.yaml.tmpl`) scraping both Aegis `/metrics` and metrics-bridge `/metrics`. Path: run `alloy convert` against `agent.yaml.tmpl`, swap the App Engine service image, verify both scrape jobs still remote-write to Grafana Cloud, then delete the agent config. Best sequenced _after_ the Aegis monorepo merge so the Alloy config lives alongside the services it scrapes. Refs: <https://grafana.com/blog/2024/04/09/grafana-agent-to-grafana-alloy-opentelemetry-collector-faq/>, <https://grafana.com/docs/alloy/latest/set-up/migrate/>

## Backlog — Future

- [ ] **Streamlit sandbox** — Python/Streamlit reads same Hasura backend
- [ ] **ClickHouse sink** — heavy analytics beyond Postgres

## Tech Debt

- [ ] Dashboard component test coverage (71 test files total, but many are lib/util — component tests sparse)
- [ ] Revenue page placeholders ("CDP Borrowing Fees" and "Reserve Yield" marked "Soon")
- [ ] **Oracle update tx-hash label** — oracle alerts currently say `Last update: X ago` as plain text. Strictly better as a hyperlink to the exact on-chain `OracleReport` tx on the block explorer. Blocked on the indexer surfacing `lastOracleUpdateTxHash` (or equivalent) on the `Pool` entity — not currently tracked. Once added, the bridge exports it as a `last_oracle_update_url` label and the Slack template wraps "X ago" in `<url|text>`.
- [ ] **Migrate Aegis v2 alerts to Slack** — Aegis still posts to Discord; v3 went Slack-native (`#alerts-critical` / `#alerts-warnings`). Unify once the v3 channel pair has a week+ of soak.

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
- [x] Rebalancer liveness (`rebalancerAddress`, `rebalanceLivenessStatus`, `effectivenessRatio` per RebalanceEvent)
- [x] **Rebalance effectiveness rollup** — `lastEffectivenessRatio` on `Pool` (KPI 4 effectiveness half, PR #212)
- [x] PoolSnapshot pre-aggregation (volume, TVL, fees per pool per hour)
- [x] PoolDailySnapshot rollup (daily aggregation)
- [x] Pool cumulative fields (`swapCount`, `notionalVolume0/1`, `rebalanceCount`)
- [x] Deviation breach tracking (`deviationBreachStartedAt` on Pool)
- [x] **Deviation breach as first-class history entity** — per-breach entries with start/end for charting (PR #194)
- [x] **Anchor-based breach deferral for multi-`ReservesUpdated` txs** — avoids double-counting (PR #205)
- [x] **Indexer perf** — parallel oracle loops, concurrent RPC+`Pool.get`, memoised rebalancing state (PR #208)
- [x] **Bounded oracle caches** — block-keyed caches capped to prevent OOM (PR #184)
- [x] **Monad mainnet indexing live** — start block backfilled (PR #175), contracts fully indexed
- [x] **ERC20 registration gated by Mento registry** — prevents malicious fee-token registration (PR #174)
- [x] FX weekend exclusion from healthscore math
- [x] FX calendar extracted to `shared-config` package
- [x] Multichain config (`config.multichain.mainnet.yaml` — Celo + Monad)
- [x] `txHash` on all events, `@index` directives for query performance
- [x] Deploy branch strategy (`deploy/celo-mainnet`, `deploy/celo-sepolia`)
- [x] Token addresses sourced from `@mento-protocol/contracts`
- [x] Retry + fallback RPC on rate limit and block-out-of-range errors

### Dashboard

- [x] Live at monitoring.mento.org
- [x] Global overview page (`/`) — metrics tiles, all pools table, activity ranking
- [x] **SSR homepage + slim per-page GraphQL fetches** (PR #207)
- [x] Pool detail page (`/pools/[poolId]`) — trades, reserve chart, analytics tab
- [x] **Pool header v2** — Health Score retired; deviation breaches live in a dedicated tab with chart (PR #196)
- [x] Oracle health: HealthBadge, HealthPanel, OracleChart (dual y-axis)
- [x] Analytics tab with PoolSnapshot charts
- [x] Fully multichain — network switcher dropped, chain icon prefix on pool IDs
- [x] Token symbol mapping, `isFpmm()` in `tokens.ts`
- [x] Shared `PoolsTable` component
- [x] **CDP strategy badge** on global pools table (PR #214; stopgap RPC probe, see `Next` for indexer replacement)
- [x] LimitBadge + LimitPanel (trading limit pressure per token)
- [x] RebalancerBadge + RebalancerPanel (liveness status + diagnostics)
- [x] TVL on global page — TVL-over-time chart + tiles with 24h/7d/30d change %
- [x] TVL Δ WoW column on all pools table
- [x] Protocol Revenue page (`/revenue`) — swap fee time-series
- [x] Daily volume chart on pool detail
- [x] **Bridge-flows page v2** — pagination, status filter, duration column, range tabs (PR #173), stuck-transfer redeem CTA (PR #185), tighter table + route delivery tile + time links (PR #186), array-syntax `order_by` + chain icons on sender/receiver (PR #187)
- [x] Error boundaries + loading skeletons (route-level)
- [x] **SWR backoff + 429 retry gating** — visibility/online-aware polling (PR #202)
- [x] Google Auth (NextAuth.js — `@mentolabs.xyz` only)
- [x] **Auth hardening** — `hd` + `email_verified` check, middleware-enforced allowlist, 1h JWT (PR #190)
- [x] **Security headers** — full CSP + HSTS; removed unauthenticated GET on address labels (PR #189)
- [x] **XSS hardening** — escape user-controlled labels before Plotly renders (PR #171)
- [x] **Shared prod/preview auth posture** — documented + RSC label-leak regression guard + callback-URL sanitizer tests (PRs #172, #192)

### Shared packages

- [x] **`shared-config` chain + token metadata** — `POOL_PAIR_LABELS`, `CHAIN_NAMES`, `BLOCK_EXPLORER_BASE_URLS` extracted from `metrics-bridge/src/config.ts` and dashboard duplicates; single source of truth (PR #213)
- [x] FX calendar in `shared-config/fx-calendar.json`

### Infrastructure (Done)

- [x] Monorepo extraction from devnet repo
- [x] CI: ESLint 10 + Vitest (71 test files) + typecheck + Codecov
- [x] **Single aggregate CI workflow** — `ci.yml` fans out to `ui` / `indexer` / `bridge` via path filter; lint via Trunk is the only other required check (PR #188)
- [x] **Path filters unified + skip-holes closed** across all workflows (PRs #176, #217)
- [x] **CI pinned to commit SHAs** — `claude-code-action` + `checkout` (PR #177)
- [x] **High/critical npm advisory block** on merge (PR #191)
- [x] `pnpm deploy:indexer [network]` (prompts if no network passed)
- [x] `pnpm update-endpoint:mainnet` — Vercel env var update after indexer redeploy
- [x] Discord notification on deploy branch push (`notify-envio-deploy.yml`)
- [x] Deployment docs (`docs/deployment.md`)
- [x] Non-interactive deploy scripts (status, promote, logs)

### v3 Alerting (shipped this week)

- [x] **GCP project `mento-monitoring`** — bootstrapped via Terraform; org-level SA owner (PR #197)
- [x] **Cloud Run `metrics-bridge`** — 512Mi mem (PR #198), `cpu_idle=false`, `/health` probe path (PR #199; Cloud Run v2 reserves `/healthz` at the frontend)
- [x] **Cloud Run deploy IAM** — `serviceusage.serviceUsageConsumer` + logging writer on bridge deploy SA (PRs #216, #218)
- [x] **Workload Identity Federation** for CI deploys — no long-lived keys (PR #200)
- [x] **Image rollouts out of Terraform** — `lifecycle.ignore_changes` on image, `gcloud run services update` drives rollouts, `--revision-suffix=<sha>-<run-id>` for self-describing rollbacks (PR #201)
- [x] **Per-chain Hasura URL consolidation** — single `NEXT_PUBLIC_HASURA_URL`; dropped hosted testnet entries (PR #195)
- [x] **Bridge label alignment** — pool health rule simplified + labels match Wormholescan (PR #193)
- [x] **Schema-lag fallback removed** — post-#212 deploy-order race mooted once Envio redeploy promoted (PR #219)
- [x] **Grafana Agent scrape target** — polls `metrics-bridge` `/metrics` every 30s (aegis PR #48)
- [x] **Grafana Agent container hardening chain** — Alpine→Debian (#51), UID/GID 1000 (#52), deprecated `server:` block (#53), WAL-dir perms under non-root (#54)
- [x] **First v3 Slack alert rules** in `terraform/alerts/` — 5 groups / 9 rules across `service=fpmms` + `service=metrics-bridge` (PR #206)
- [x] **Rebalance effectiveness alert** — `mento_pool_rebalance_effectiveness` gauge + Approach B (`avg_over_time < 0.2 AND deviation_ratio >= 1 AND increase(rebalance_count_total) > 0`, `for=15m`) (PR #212)
- [x] **Slack UX** — pool pair labels populated (PR #209), tightened copy w/ oracle age (PR #211), channel name corrected to `#alerts-warnings` (PR #210)
- [x] **Channel structure decision** — severity-split (`#alerts-critical` + `#alerts-warnings`) rather than domain-split (`#alerts-v3`); routing via rule-level `notification_settings` to bypass the Aegis-owned singleton notification policy

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
