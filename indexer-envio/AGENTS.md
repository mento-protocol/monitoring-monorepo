---
title: Envio Indexer Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
doc_type: agent-instructions
scope: indexer-envio
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Envio Indexer

Read the `indexer-envio` records in
[`docs/adr/`](../docs/adr/README.md) before changing architecture. Package
topology, current contracts/entities, commands, environment setup, local-stack
invariants, and contract-add/promotion procedures live in
[`README.md`](README.md).

## What This Is

One Envio HyperIndex project indexes Ethereum reserve yield, Celo, Monad, and
Polygon v3 pools, Polygon Wormhole NTT flows, the Celo v2 Broker path, and Mento
Liquity/CDP state. Production behavior is defined by
`config.multichain.mainnet.yaml`, `schema.graphql`, and the loaded handler
graph—not by historical plans.

Polygon Mainnet (`137`) is the production target and Polygon Amoy (`80002`) is
the testnet target. Exact contracts, start blocks, dashboard coverage, alert
conditions, deferrals, and cutover state live in
[`../docs/notes/polygon-monitoring.md`](../docs/notes/polygon-monitoring.md).

## Before Opening PRs

For schema changes, entity/field additions, degraded RPC behavior, or any
indexer data that propagates into Hasura/UI, apply
[`../docs/pr-checklists/stateful-data-ui.md`](../docs/pr-checklists/stateful-data-ui.md).
Cross-layer/stateful work is incomplete until writers, readers, generated
types, rollout behavior, and representative browser/query tests agree.

## Key Files

- `config.multichain.mainnet.yaml` / `config.multichain.testnet.yaml` — hosted
  and testnet contract/event configuration.
- `schema.graphql` — entity contract exposed by Hasura.
- `src/EventHandlers.ts` — required handler entry point; every handler module
  must be reachable through a side-effect import here.
- `config/{aggregators,deployment-namespaces,fx-calendar,oracle-reporters}.json`
  — checked-in shared-config mirrors for hosted builds.
- `src/contractAddresses.ts` — namespace-aware contract resolution.
- `config/protocolActors.json` — only protocol actors not derivable from pool
  state, `PoolLiquidityStrategy`, contract, or NTT metadata. The populated
  `Pool.rebalancerAddress` remains a compatibility/swap fast path, not the
  authoritative active-strategy cardinality source.
- `abis/` and `scripts/generateAbis.mjs` — vendored ABI allowlist and documented
  hand-vendored exceptions.

## Commands and Local Development

Use the root `pnpm indexer:*` commands or package scripts documented in the
README. After changing schema, config, entry-point imports, or handler module
reachability, run each affected code-generation variant. Use
`pnpm indexer:testnet:codegen` for testnet inputs and
`pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen` for
bridge-only inputs. Shared schema or ABI changes affect all variants. Run
non-mainnet variants first and `pnpm indexer:codegen` last because the variants
share one generated tree. After dashboard queries change, also run
`pnpm dashboard:codegen`.

The wrapper reads `.env`, not named legacy env files. `.env.example` is the
variable reference, including Polygon's per-chain RPC and start-block
overrides. Never set generic `ENVIO_RPC_URL` in multichain mode; use per-chain
overrides, and ensure fallback RPCs cover the full archive/replay window. Keep
`ENVIO_START_BLOCK_POLYGON` at or before the first FPMM factory deployment at
block `90348018`. Local Hasura must stay on port 8080, only one `generated`
Docker stack may run at a time, and codegen must go through the wrapper so the
Postgres healthcheck is re-applied.

## Contract Types

The production config and README enumerate indexed contracts. The load-bearing
Broker rule is: `BrokerSwapEvent.routedViaV3Router` requires both a
`Routerv300` transaction target and a registered VirtualPool as the immediate
Broker caller. Legacy-v2 daily and producer rollups exclude every VirtualPool
caller, including third-party aggregator entry points, because the sibling
`VirtualPool.Swap` already carries that volume. Preserve that denormalization
when changing the v2/v3 volume path; see
[ADR 0017](../docs/adr/0017-broker-denormalization-volume-dedup.md).

## Dependencies

`@mento-protocol/contracts` owns published addresses and ABIs. Shared-config
mirrors are deliberate because Envio hosted builds can run outside the pnpm
workspace:

- Keep `config/aggregators.json`, `config/deployment-namespaces.json`,
  `config/fx-calendar.json`, and `config/oracle-reporters.json` synchronized
  with their files under `../shared-config/`; parity tests enforce equality.
- Keep `src/feeToken.ts:buildKnownTokenMeta` synchronized with the applicable
  policy in `../shared-config/src/tokens.ts`; the indexer additionally excludes
  mocks and requires decimals at its call site.

Do not replace these with a `workspace:*` dependency without a dedicated
deploy-path change; see
[ADR 0013](../docs/adr/0013-vendored-shared-config-mirror.md). ABI refresh and
address-drift rules are in
[ADR 0015](../docs/adr/0015-abi-vendoring-and-address-drift-gate.md).

## Handler and Data Invariants

Before changing handlers, RPC effects, heal stages, IDs, counters, or related
tests, apply
[`../docs/pr-checklists/indexer-handler-invariants.md`](../docs/pr-checklists/indexer-handler-invariants.md).
It owns the collision-resistant ID rule, entity rollups, trading-time units,
bounded caches, median freshness, partial-heal retry coordination, downstream
predicate/query audit, phase-local preload state (including imported
handler-helper call graphs), Vitest RPC mocks, and env parsing.

Keep RPC reads in focused effect modules and test value-returning heal stages
with hermetic effect doubles; see
[ADR 0016](../docs/adr/0016-effect-rpc-split-and-heal-stages.md).

Also apply the shared recurring-review rules for file-size limits, multichain
enumeration, Hasura row caps, and effect-layer boundaries:
[`../docs/pr-checklists/recurring-review-patterns.md`](../docs/pr-checklists/recurring-review-patterns.md).

## Liquity / CDP

Read
[`../docs/notes/liquity-monitoring-invariants.md`](../docs/notes/liquity-monitoring-invariants.md)
before changing Liquity handlers, schema, queries, or KPIs. Never replace
`systemDebt` with cached `activePoolDebt + defaultPoolDebt`; the deployed
ActivePool emits no debt updates. Rebalance redemptions are a subset
discriminated by transaction target, not a distinct event type.

## Observability

Use `context.log.error` names (`<area>.<event>`); never add Sentry. Envio logs
diagnose; Prometheus/Grafana metrics and rules alert.
[ADR 0052](../docs/adr/0052-envio-logs-prometheus-grafana-alerting.md) defines
the commands and classifications.
