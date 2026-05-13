# Mento v3 Envio HyperIndex Indexer

Multichain Envio HyperIndex indexer for Mento v3 — Celo Mainnet (42220) and Monad Mainnet (143).
Tracks FPMM pool activity, oracle health, trading limits, and rebalancer liveness.

## What It Does

Listens to on-chain events from Mento v3 contracts and writes structured entities to Postgres, exposed via Hasura GraphQL.

### Events Indexed

| Contract              | Events                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Broker                | `Swap` (legacy v2 settlement layer; Celo only — no Broker on Monad)                                          |
| FPMMFactory           | `FPMMDeployed`                                                                                               |
| FPMM (pool)           | `Swap`, `Mint`, `Burn`, `UpdateReserves`, `Rebalanced`, `TradingLimitConfigured`, `LiquidityStrategyUpdated` |
| VirtualPool           | `Swap`, `Mint`, `Burn`, `UpdateReserves`, `Rebalanced`                                                       |
| VirtualPoolFactory    | `VirtualPoolDeployed`, `PoolDeprecated`                                                                      |
| SortedOracles         | `OracleReported`, `MedianUpdated`, `ReportExpirySet`, `TokenReportExpirySet`                                 |
| OpenLiquidityStrategy | `PoolAdded`, `PoolRemoved`, `LiquidityMoved`, `RebalanceCooldownSet`                                         |
| ERC20FeeToken         | `Transfer` (dynamically registered from FPMMDeployed events)                                                 |

### Entities Written

| Entity                 | Description                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `Pool`                 | Per-pool state: reserves, health, oracle, trading limits, rebalancer liveness                          |
| `PoolSnapshot`         | Hourly aggregates: volume, TVL, swap count                                                             |
| `OracleSnapshot`       | Per-oracle-event: price, deviation, health status                                                      |
| `TradingLimit`         | Per-pool per-token: limit state, netflow, pressure ratio                                               |
| `SwapEvent`            | Individual v3 swap: amounts in/out, txHash, timestamp                                                  |
| `LiquidityEvent`       | Mint/burn events                                                                                       |
| `ReserveUpdate`        | Reserve snapshots on every `UpdateReserves`                                                            |
| `RebalanceEvent`       | Per-rebalance: improvement, effectiveness ratio                                                        |
| `FactoryDeployment`    | Pool creation events from factory                                                                      |
| `VirtualPoolLifecycle` | VirtualPool deploy/deprecate events                                                                    |
| `OlsPool`              | Open Liquidity Strategy pool registrations                                                             |
| `OlsLiquidityEvent`    | OLS liquidity movements                                                                                |
| `ProtocolFeeTransfer`  | ERC20 fee token transfers                                                                              |
| `BrokerSwapEvent`      | Individual legacy v2 swap (Broker → BiPoolManager); flags `routedViaV3Router` to dedupe vs VirtualPool |
| `BrokerDailySnapshot`  | Daily v2 volume rollup keyed by `(chainId, exchangeProvider, routedViaV3Router, day)`                  |

### Pool ID Format

All entity IDs are namespaced by chain: `{chainId}-{address}` (e.g. `42220-0x02fa...`, `143-0xd0e9...`).
This prevents collisions when the same contract address is deployed on multiple chains.

## Configuration

| File                             | Networks                                          |
| -------------------------------- | ------------------------------------------------- |
| `config.multichain.mainnet.yaml` | Celo Mainnet + Monad Mainnet (default/production) |
| `config.multichain.testnet.yaml` | Celo Sepolia + Monad Testnet                      |

Deploy branch: `envio` → triggers hosted reindex on push.

## Local Development

### Prerequisites

- Node.js 22 LTS
- pnpm 10.x
- Docker Desktop (runs Postgres + Hasura locally)

### Setup

```bash
cp indexer-envio/.env.example indexer-envio/.env
# Mainnet defaults (forno, rpc2.monad.xyz) work out of the box.
# For testnet, set ENVIO_API_TOKEN or override ENVIO_RPC_URL_10143.

# Generate types + start multichain indexer
pnpm indexer:codegen && pnpm indexer:dev
```

Hasura console: `http://localhost:8080` (admin secret: `testing`)
GraphQL endpoint: `http://localhost:8080/v1/graphql`

### Available Commands (from repo root)

```bash
pnpm indexer:codegen                # Generate types (multichain mainnet — Celo + Monad)
pnpm indexer:dev                    # Start local multichain mainnet indexer
pnpm indexer:testnet:codegen        # Generate types (multichain testnet — Celo Sepolia + Monad testnet)
pnpm indexer:testnet:dev            # Start local multichain testnet indexer
pnpm deploy:indexer                 # Push to envio branch → triggers hosted reindex
```

### From `indexer-envio/` directory

```bash
pnpm codegen    # Generate types
pnpm dev        # Start indexer stack
pnpm start      # Start without codegen
pnpm stop       # Stop Docker containers
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
pnpm deploy:indexer
```

The `mento` project on Envio Cloud watches this branch. The static production endpoint never changes on redeploy:

```
https://indexer.hyperindex.xyz/2f3dd15/v1/graphql
```

See [`STATUS.md`](./STATUS.md) for current sync state and endpoint details.

## Key Files

| File                                | Purpose                                   |
| ----------------------------------- | ----------------------------------------- |
| `schema.graphql`                    | Entity model                              |
| `src/EventHandlers.ts`              | Event → entity mapping                    |
| `src/helpers.ts`                    | `makePoolId`, `poolIdToAddress` utilities |
| `src/rpc.ts`                        | RPC read helpers (per-chain clients)      |
| `config.multichain.mainnet.yaml`    | Production config (Celo + Monad)          |
| `config/deployment-namespaces.json` | Vendored namespace map for hosted builds  |
| `abis/`                             | Contract ABIs                             |
