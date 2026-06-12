# Mento v3 Envio HyperIndex Indexer

Multichain Envio HyperIndex indexer for Mento v3 — Celo Mainnet (42220), Monad Mainnet (143), and Ethereum Mainnet (1) sUSDS reserve-yield events.
Tracks FPMM pool activity, oracle health, trading limits, rebalancer liveness, and reserve-yield accounting.

## What It Does

Listens to on-chain events from Mento v3 contracts and writes structured entities to Postgres, exposed via Hasura GraphQL.

### Events Indexed

| Contract              | Events                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broker                | `Swap` (legacy v2 settlement layer; Celo only - no Broker on Monad)                                                                                                                                                      |
| FPMMFactory           | `FPMMDeployed`                                                                                                                                                                                                           |
| FPMM (pool)           | `Swap`, `Mint`, `Burn`, `Transfer`, `UpdateReserves`, `Rebalanced`, `TradingLimitConfigured`, `LiquidityStrategyUpdated`, `LPFeeUpdated`, `ProtocolFeeUpdated`, `RebalanceIncentiveUpdated`, `RebalanceThresholdUpdated` |
| VirtualPool           | `Swap`, `Mint`, `Burn`, `UpdateReserves`, `Rebalanced`                                                                                                                                                                   |
| VirtualPoolFactory    | `VirtualPoolDeployed`, `PoolDeprecated`                                                                                                                                                                                  |
| SortedOracles         | `OracleReported`, `MedianUpdated`, `ReportExpirySet`, `TokenReportExpirySet`                                                                                                                                             |
| BiPoolManager         | `ExchangeCreated`, `ExchangeDestroyed`, `BucketsUpdated`, `SpreadUpdated`                                                                                                                                                |
| OpenLiquidityStrategy | `PoolAdded`, `PoolRemoved`, `LiquidityMoved`, `RebalanceCooldownSet`                                                                                                                                                     |
| ERC20FeeToken         | `Transfer` (dynamically registered from FPMMDeployed events)                                                                                                                                                             |
| BreakerBox            | `BreakerAdded`, `BreakerRemoved`, `BreakerStatusUpdated`, `RateFeedAdded`, `RateFeedRemoved`, `RateFeedDependenciesSet`, `BreakerTripped`, `ResetSuccessful`, `TradingModeUpdated`                                       |
| MedianDeltaBreaker    | `DefaultCooldownTimeUpdated`, `RateFeedCooldownTimeUpdated`, `DefaultRateChangeThresholdUpdated`, `RateChangeThresholdUpdated`, `SmoothingFactorSet`, `MedianRateEMAReset`                                               |
| ValueDeltaBreaker     | `DefaultCooldownTimeUpdated`, `RateFeedCooldownTimeUpdated`, `DefaultRateChangeThresholdUpdated`, `RateChangeThresholdUpdated`, `ReferenceValueUpdated`                                                                  |
| WormholeNttManager    | `TransferSent`, `TransferRedeemed`, `MessageAttestedTo`, `InboundTransferQueued`                                                                                                                                         |
| WormholeTransceiver   | `ReceivedMessage`                                                                                                                                                                                                        |
| Susds                 | `Deposit`, `Withdraw`, `Transfer` (Ethereum only; filtered to tracked Mento reserve wallets)                                                                                                                             |

### Entities Written

| Entity group            | Description                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool state              | `Pool`, `DeviationThresholdBreach`, `OracleSnapshot`, `TradingLimit`                                                                                                            |
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
| Reserve yield           | `SusdsYieldMovement`, `SusdsCostBasisLot`, `SusdsPosition`, `SusdsYieldSummary`                                                                                                 |

### Pool ID Format

All entity IDs are namespaced by chain: `{chainId}-{address}` (e.g. `42220-0x02fa...`, `143-0xd0e9...`).
This prevents collisions when the same contract address is deployed on multiple chains.

## Configuration

| File                                 | Networks                                                           |
| ------------------------------------ | ------------------------------------------------------------------ |
| `config.multichain.mainnet.yaml`     | Celo Mainnet + Monad Mainnet + Ethereum sUSDS (default/production) |
| `config.multichain.testnet.yaml`     | Celo Sepolia + Monad Testnet                                       |
| `config.multichain.bridge-only.yaml` | Local bridge-flow validation harness                               |

`config/protocolActors.json` contains manual protocol-controlled caller and
entry-point overrides for the dashboard volume filter. Pool liquidity-strategy
contracts are classified automatically from `Pool.rebalancerAddress`; add
manual entries only for protocol actors that cannot be derived from pool state
or the normal contract/NTT address metadata.

Deploy branch: `envio` → triggers hosted reindex on push.

## Local Development

### Prerequisites

- Node.js 22 LTS
- pnpm 10.x
- Docker Desktop (runs Postgres + Hasura locally)

### Setup

```bash
cp indexer-envio/.env.example indexer-envio/.env
# Mainnet defaults (forno, rpc2.monad.xyz, ethereum.publicnode.com) work out of the box.
# For testnet, set ENVIO_API_TOKEN or override ENVIO_RPC_URL_10143.

# Generate types + start multichain indexer
pnpm indexer:codegen && pnpm indexer:dev
```

Hasura console: `http://localhost:8080` (admin secret: `testing`)
GraphQL endpoint: `http://localhost:8080/v1/graphql`

### Available Commands (from repo root)

```bash
pnpm indexer:codegen                # Generate types (multichain mainnet — Celo + Monad + Ethereum sUSDS)
pnpm indexer:dev                    # Start local multichain mainnet indexer
pnpm indexer:testnet:codegen        # Generate types (multichain testnet — Celo Sepolia + Monad testnet)
pnpm indexer:testnet:dev            # Start local multichain testnet indexer
pnpm deploy:indexer                 # Push to envio branch → triggers hosted reindex
pnpm deploy:indexer:status <commit> --watch  # Wait for registration, then watch sync state
pnpm deploy:indexer:logs <commit> --build    # Show build logs for a deployment
pnpm deploy:indexer:logs <commit> --level error,warn --since 2h  # Show runtime issues
pnpm deploy:indexer:metrics <commit>         # Show per-chain indexing progress
pnpm deploy:indexer:info <commit>            # Show deployment info/cache state
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
pnpm deploy:indexer:status "$COMMIT" --watch
pnpm deploy:indexer:logs "$COMMIT" --build
pnpm deploy:indexer:logs "$COMMIT" --level error,warn --since 2h
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

See [`STATUS.md`](./STATUS.md) for current sync state and endpoint details.

## Key Files

| File                                | Purpose                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `schema.graphql`                    | Entity model                                            |
| `src/EventHandlers.ts`              | Event → entity mapping                                  |
| `src/helpers.ts`                    | `makePoolId`, `poolIdToAddress` utilities               |
| `src/rpc.ts` + `src/rpc/`           | RPC read helpers (per-chain clients, effects, fallback) |
| `config.multichain.mainnet.yaml`    | Production config (Celo + Monad + Ethereum sUSDS)       |
| `config/deployment-namespaces.json` | Vendored namespace map for hosted builds                |
| `abis/`                             | Vendored contract ABI subsets                           |
