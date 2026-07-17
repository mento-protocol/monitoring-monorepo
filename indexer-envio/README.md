<!-- agent-context: title="Mento v3 Envio HyperIndex Indexer" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=reference scope=indexer-envio review_interval_days=90 garden_lane=package-readmes-reference -->

# Mento v3 Envio HyperIndex Indexer

Multichain Envio HyperIndex indexer for Mento v3 — Ethereum reserve-yield (1),
Celo Mainnet (42220), Monad Mainnet (143), and Polygon Mainnet (137). Tracks FPMM pool activity,
oracle health, trading limits, rebalancer liveness, event-driven sUSDS reserve
yield, and stETH reserve yield with a sub-daily wallet balance sampler that
writes daily snapshots. The historical sUSDS `onBlock` heartbeat is
intentionally excluded from the hosted path.

## What It Does

Listens to on-chain events from Mento v3 contracts and writes structured entities to Postgres, exposed via Hasura GraphQL.

### Selected Events Indexed

The production config is the source of truth for the complete contract and
event list; the table highlights the main monitoring surfaces.

| Contract              | Events                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broker                | `Swap` (legacy v2 settlement layer; Celo only - no Broker on Monad or Polygon)                                                                                                                                           |
| FPMMFactory           | `FPMMDeployed`                                                                                                                                                                                                           |
| FPMM (pool)           | `Swap`, `Mint`, `Burn`, `Transfer`, `UpdateReserves`, `Rebalanced`, `TradingLimitConfigured`, `LiquidityStrategyUpdated`, `LPFeeUpdated`, `ProtocolFeeUpdated`, `RebalanceIncentiveUpdated`, `RebalanceThresholdUpdated` |
| VirtualPool           | `Swap`, `Mint`, `Burn`, `UpdateReserves`, `Rebalanced`                                                                                                                                                                   |
| VirtualPoolFactory    | `VirtualPoolDeployed`, `PoolDeprecated`                                                                                                                                                                                  |
| SortedOracles         | `OracleAdded`, `OracleRemoved`, `OracleReported`, `MedianUpdated`, `ReportExpirySet`, `TokenReportExpirySet`                                                                                                             |
| BiPoolManager         | `ExchangeCreated`, `ExchangeDestroyed`, `BucketsUpdated`, `SpreadUpdated`                                                                                                                                                |
| OpenLiquidityStrategy | `PoolAdded`, `PoolRemoved`, `LiquidityMoved`, `RebalanceCooldownSet`                                                                                                                                                     |
| ERC20FeeToken         | `Transfer` (dynamically registered from FPMMDeployed events)                                                                                                                                                             |
| BreakerBox            | `BreakerAdded`, `BreakerRemoved`, `BreakerStatusUpdated`, `RateFeedAdded`, `RateFeedRemoved`, `RateFeedDependenciesSet`, `BreakerTripped`, `ResetSuccessful`, `TradingModeUpdated`                                       |
| MedianDeltaBreaker    | `DefaultCooldownTimeUpdated`, `RateFeedCooldownTimeUpdated`, `DefaultRateChangeThresholdUpdated`, `RateChangeThresholdUpdated`, `SmoothingFactorSet`, `MedianRateEMAReset`                                               |
| ValueDeltaBreaker     | `DefaultCooldownTimeUpdated`, `RateFeedCooldownTimeUpdated`, `DefaultRateChangeThresholdUpdated`, `RateChangeThresholdUpdated`, `ReferenceValueUpdated`                                                                  |
| WormholeNttManager    | `TransferSent`, `TransferRedeemed`, `MessageAttestedTo`, `InboundTransferQueued`                                                                                                                                         |
| WormholeTransceiver   | `ReceivedMessage`                                                                                                                                                                                                        |

### Entities Written

| Entity group            | Description                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool state              | `Pool`, `DeviationThresholdBreach`, `OracleSnapshot`, `TradingLimit`                                                                                                            |
| Pool strategies         | `PoolLiquidityStrategy` (authoritative active many-to-many registry; `Pool.rebalancerAddress` is compatibility-only)                                                            |
| Pool activity           | `SwapEvent`, `LiquidityEvent`, `ReserveUpdate`, `RebalanceEvent`, `LiquidityPosition`, `FactoryDeployment`                                                                      |
| Pool rollups            | `PoolSnapshot`, `PoolDailySnapshot`, `PoolDailyVolumeSnapshot`, `PoolDailyFeeSnapshot`                                                                                          |
| Protocol fees           | `ProtocolFeeTransfer`                                                                                                                                                           |
| Legacy v2 / Broker      | `BrokerSwapEvent`, `BrokerDailySnapshot`, `BrokerExchangeDailySnapshot`, `BrokerTraderDailySnapshot`                                                                            |
| Broker aggregators      | `BrokerAggregatorDailySnapshot`, `BrokerAggregatorTraderDayMarker`, `BrokerVolumeWindowSnapshot`                                                                                |
| BiPoolManager           | `BiPoolExchange`, `BucketUpdate`                                                                                                                                                |
| VirtualPools            | `VirtualPoolLifecycle`                                                                                                                                                          |
| Open Liquidity Strategy | `OlsPool`, `OlsLiquidityEvent`, `OlsLifecycleEvent`                                                                                                                             |
| Circuit breakers        | `Breaker`, `BreakerConfig`, `BreakerTripEvent`, `RateFeedDependency`                                                                                                            |
| Bridge flows            | `BridgeTransfer`, `BridgeAttestation`, `BridgeDailySnapshot`, `BridgeBridger`, `WormholeNttManager`, `WormholeTransferDetail`, `WormholeDestPending`, `WormholeTransferPending` |
| Volume and participants | `TraderDailySnapshot`, `TraderPoolDailySnapshot`, `AggregatorDailySnapshot`, `VolumeWindowSnapshot`                                                                             |
| Reserve yield           | Ethereum sUSDS/stETH movement, cost-basis, position, summary, and daily-snapshot entities; stETH also records `StethWalletLaunchBaseline` for the balance sampler               |

### Pool ID Format

All entity IDs are namespaced by chain: `{chainId}-{address}` (e.g. `42220-0x02fa...`, `143-0xd0e9...`).
This prevents collisions when the same contract address is deployed on multiple chains.

## Configuration

| File                                 | Networks                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `config.multichain.mainnet.yaml`     | Ethereum reserve-yield + Celo + Monad + Polygon mainnets (default/production) |
| `config.multichain.testnet.yaml`     | Celo Sepolia + Monad Testnet + Polygon Amoy                                   |
| `config.multichain.bridge-only.yaml` | Local Celo + Monad + Polygon bridge-flow validation harness                   |

`config/protocolActors.json` contains manual protocol-controlled caller and
entry-point overrides for the dashboard volume filter. Pool liquidity-strategy
cardinality comes from `PoolLiquidityStrategy`. The populated
`Pool.rebalancerAddress` compatibility pointer remains the swap-time fast path
for dynamic strategies, while named strategies are also discovered from the
contracts manifest. Add manual entries only for protocol actors that cannot be
derived from those sources or normal NTT address metadata.

Deploy branch: `envio` → triggers hosted reindex on push.

## Local Development

### Prerequisites

- Node.js 24 LTS
- pnpm 11.x
- Docker Desktop (runs Postgres + Hasura locally)

### Setup

```bash
cp indexer-envio/.env.example indexer-envio/.env
# Mainnet defaults (forno, rpc2.monad.xyz, polygon.drpc.org) work out of the box.
# For testnet, set ENVIO_API_TOKEN or override ENVIO_RPC_URL_10143.
# For reserve-yield, set ENVIO_RPC_URL_1 to an archive-capable Ethereum RPC
# before replaying old sUSDS/stETH events locally.

# Generate types + start multichain indexer
pnpm indexer:codegen && pnpm indexer:dev
```

Hasura console: `http://localhost:8080` (admin secret: `testing`)
GraphQL endpoint: `http://localhost:8080/v1/graphql`

### Available Commands (from repo root)

```bash
pnpm indexer:codegen                # Generate types (multichain mainnet — Ethereum reserve-yield + Celo + Monad + Polygon)
pnpm indexer:dev                    # Start local multichain mainnet indexer
pnpm indexer:testnet:codegen        # Generate types (multichain testnet — Celo Sepolia + Monad testnet + Polygon Amoy)
pnpm indexer:testnet:dev            # Start local multichain testnet indexer
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test     # Codegen mainnet config, run sUSDS/stETH tests, restore mainnet codegen
pnpm deploy:indexer                 # Push to envio branch → triggers hosted reindex
pnpm deploy:indexer:status <commit> --watch --compact  # Low-noise wait for registration + sync
pnpm deploy:indexer:logs <commit> --build    # Show build logs for a deployment
pnpm deploy:indexer:logs <commit> --level error,warn --since 2h  # Show runtime issues
pnpm deploy:indexer:metrics <commit>         # Show per-chain indexing progress
pnpm deploy:indexer:info <commit>            # Show deployment info/cache state
pnpm deploy:indexer:perf <commit>            # Combined status/metrics/log snapshot for perf comparisons
pnpm deploy:indexer:verify <commit>          # Batch status, metrics, endpoint, and GraphQL row probe
pnpm deploy:indexer:promote <commit>         # Promote a synced deployment to prod
```

### From `indexer-envio/` directory

```bash
pnpm codegen    # Generate types
pnpm dev        # Start indexer stack
pnpm start      # Start without codegen
pnpm stop       # Stop Docker containers
pnpm test:mutation     # Targeted StrykerJS pure-logic baseline
pnpm knip:report       # Report-only unused-file/export/dependency scan
```

### Performance Diagnostics

Enable opt-in sync profiling when comparing local replays or a hosted debug
deployment:

```bash
INDEXER_PERF=1 INDEXER_PERF_LOG_INTERVAL_EVENTS=10000 pnpm indexer:dev
```

The profiler logs the slowest handlers, effect request/execution counts
(`hit~` is request count minus effect handler executions, i.e. preload/cache
dedup), and entity get/set counters. It is disabled by default and has no
runtime effect unless `INDEXER_PERF` is truthy.

For hosted comparisons, use `pnpm deploy:indexer:perf <commit>` to capture the
deployment registry row, per-chain status/metrics, build highlights, and recent
warn/error logs in one snapshot. For local Envio CLI checks, `envio@3.2.1`
also includes `envio metrics runtime` and `envio tools search-docs` /
`envio tools fetch-docs`.

Before removing `schema.graphql` indexes, run the static usage audit:

```bash
node indexer-envio/scripts/auditSchemaIndexes.mjs
```

The audit maps `@index` directives to handler `getWhere` calls and
dashboard/bridge GraphQL `where`, `order_by`, and `distinct_on` usage, including
known dynamic discovery queries. Treat the output as a review aid, not an
automatic deletion list.

## Schema

See [`schema.graphql`](./schema.graphql) for the full entity model.

Key design decisions:

- `PoolSnapshot` uses hourly buckets (forward-fill for charts is done in the dashboard)
- `TradingLimit` has composite ID: `{poolId}-{tokenAddress}`
- All BigInt fields use string representation in GraphQL responses

## Example Queries

**Recent swaps:**

```graphql
query RecentSwaps {
  SwapEvent(limit: 20, order_by: { blockTimestamp: desc }) {
    id
    chainId
    poolId
    amount0In
    amount1In
    amount0Out
    amount1Out
    txHash
    blockTimestamp
  }
}
```

**Pool health state:**

```graphql
query PoolHealth {
  Pool {
    id
    chainId
    token0
    token1
    healthStatus
    oracleOk
    priceDifference
    rebalanceThreshold
    limitStatus
    limitPressure0
    limitPressure1
    rebalanceLivenessStatus
  }
}
```

## Deployment

Push to the `envio` branch to trigger a hosted reindex:

```bash
COMMIT=$(git rev-parse HEAD)
pnpm deploy:indexer
pnpm deploy:indexer:status "$COMMIT" --watch --compact
pnpm deploy:indexer:logs "$COMMIT" --build
pnpm deploy:indexer:logs "$COMMIT" --level error,warn --since 2h
pnpm deploy:indexer:perf "$COMMIT"
pnpm deploy:indexer:verify "$COMMIT"
pnpm deploy:indexer:promote "$COMMIT"
```

The `mento` project on Envio Cloud watches this branch. Envio registers
deployments under the short commit hash, and the registration can lag the Git
push by several minutes. Use the explicit commit form above while babysitting a
new deploy; the no-commit logs/promote helpers intentionally operate on the
latest deployment currently visible to Envio, which may still be the old prod
deployment during registration lag. Promote the caught-up deployment before
treating it as live. The static production endpoint never changes on redeploy:

```
https://indexer.hyperindex.xyz/2f3dd15/v1/graphql
```

See [`STATUS.md`](./STATUS.md) for the static endpoint and deployment reference.

## Key Files

| File                                | Purpose                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `schema.graphql`                    | Entity model                                            |
| `src/EventHandlers.ts`              | Event → entity mapping                                  |
| `src/helpers.ts`                    | `makePoolId`, `poolIdToAddress` utilities               |
| `src/rpc.ts` + `src/rpc/`           | RPC read helpers (per-chain clients, effects, fallback) |
| `config.multichain.mainnet.yaml`    | Production config (Ethereum + Celo + Monad + Polygon)   |
| `config/deployment-namespaces.json` | Vendored namespace map for hosted builds                |
| `abis/`                             | Vendored contract ABI subsets                           |
