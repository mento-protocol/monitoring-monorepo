# Mento v3 Envio HyperIndex Indexer

Envio HyperIndex indexer for Mento v3 on Celo Mainnet and Celo Sepolia. Tracks FPMM pool activity, oracle health, trading limits, and rebalancer liveness.

## What It Does

The indexer listens to on-chain events from Mento v3 contracts and writes structured entities to Postgres, exposed via Hasura GraphQL.

### Events Indexed

| Contract           | Events                                                      |
| ------------------ | ----------------------------------------------------------- |
| FPMMFactory        | `FPMMDeployed`                                              |
| FPMM (pool)        | `Swap`, `Mint`, `Burn`, `UpdateReserves`, `Rebalanced`      |
| VirtualPoolFactory | `VirtualPoolDeployed`, `PoolDeprecated`                     |
| SortedOracles      | `OracleReportRemoved`, `OracleReportUpdated` (mainnet only) |

### Entities Written

| Entity                 | Description                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `Pool`                 | Per-pool state: reserves, health status, oracle state, trading limits, rebalancer liveness |
| `PoolSnapshot`         | Hourly pre-aggregated: volume, TVL, swap count, rebalance count                            |
| `OracleSnapshot`       | Per-oracle-event: price, deviation, health status                                          |
| `TradingLimit`         | Per-pool per-token: limit state, netflow, pressure ratio                                   |
| `SwapEvent`            | Individual swap: amounts in/out, txHash, timestamp                                         |
| `LiquidityEvent`       | Mint/burn events: amounts, txHash                                                          |
| `ReserveUpdate`        | Reserve snapshots on every `UpdateReserves`                                                |
| `RebalanceEvent`       | Per-rebalance: improvement, effectiveness ratio                                            |
| `FactoryDeployment`    | Pool creation events from factory                                                          |
| `VirtualPoolLifecycle` | VirtualPool deploy/deprecate events                                                        |

### Pool Type Logic

FPMM pools (4 on mainnet) have oracle health, trading limits, and rebalancer liveness.
VirtualPools get `"N/A"` for these fields.

The single source of truth is `isFpmm()` in `ui-dashboard/src/lib/tokens.ts`, which checks the pool's source field.

## Mainnet Contracts

| Contract      | Address                                      |
| ------------- | -------------------------------------------- |
| FPMMFactory   | `0xa849b475FE5a4B5C9C3280152c7a1945b907613b` |
| Router        | `0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6` |
| OracleAdapter | `0xa472fBBF4b890A54381977ac392BdF82EeC4383a` |
| SortedOracles | `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33` |

Start block: `60664513`

## Mainnet FPMM Pools

| Pool Address                                 | Pair           |
| -------------------------------------------- | -------------- |
| `0x8c0014afe032e4574481d8934504100bf23fcb56` | USDm / GBPm    |
| `0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d` | USDm / axlUSDC |
| `0x462fe04b4fd719cbd04c0310365d421d02aaa19e` | USDm / USDC    |
| `0x0feba760d93423d127de1b6abecdb60e5253228d` | USDT / USDm    |

## Configuration Files

| File                       | Network             |
| -------------------------- | ------------------- |
| `config.celo.mainnet.yaml` | Celo Mainnet        |
| `config.celo.sepolia.yaml` | Celo Sepolia        |
| `config.celo.devnet.yaml`  | Celo DevNet (local) |

## Schema

See [`schema.graphql`](./schema.graphql) for the full entity model.

Key design decisions:

- `PoolSnapshot` uses hourly buckets (industry standard, Uniswap/Balancer pattern)
- Gap-filling for charts is done in the dashboard layer (forward-fill) — Envio `onBlock` handlers lack timestamps
- `TradingLimit` has a composite ID: `{poolId}-{tokenAddress}`
- All BigInt fields use string representation in GraphQL responses

## Local Development

### Prerequisites

- Node.js 22 LTS
- pnpm 10.x
- Docker Desktop (runs Postgres + Hasura locally)

### Setup

```bash
# From repo root
cp indexer-envio/.env.example indexer-envio/.env
# Edit .env: set ENVIO_RPC_URL and ENVIO_START_BLOCK

# Generate types from schema + config
pnpm indexer:celo-sepolia:codegen

# Start indexer stack (Docker + indexer)
pnpm indexer:celo-sepolia:dev
```

Hasura console: `http://localhost:8080` (admin secret: `testing`)
GraphQL endpoint: `http://localhost:8080/v1/graphql`

### Available Commands (from repo root)

```bash
pnpm indexer:codegen                # Generate types (multichain — Celo + Monad mainnet)
pnpm indexer:dev                    # Start local multichain indexer
pnpm indexer:celo-sepolia:codegen   # Generate types for Celo Sepolia testnet
pnpm indexer:celo-sepolia:dev       # Start local Celo Sepolia indexer
pnpm indexer:monad-testnet:codegen  # Generate types for Monad Testnet
pnpm indexer:monad-testnet:dev      # Start local Monad Testnet indexer
pnpm deploy:indexer                 # Push to envio branch → triggers hosted reindex
```

### From `indexer-envio/` directory

```bash
pnpm codegen    # Generate types (loads .env automatically)
pnpm dev        # Start indexer stack
pnpm start      # Start without codegen
pnpm stop       # Stop Docker containers
```

## Key Files

| File                                | Purpose                                              |
| ----------------------------------- | ---------------------------------------------------- |
| `schema.graphql`                    | Entity model (Hasura schema)                         |
| `src/EventHandlers.ts`              | Event → entity mapping logic                         |
| `src/contractAddresses.ts`          | Contract/package address resolution                  |
| `config/deployment-namespaces.json` | Vendored namespace map for Envio hosted builds       |
| `config.celo.mainnet.yaml`          | Mainnet chain config, contracts, events, start block |
| `config.celo.sepolia.yaml`          | Sepolia chain config                                 |
| `abis/`                             | Contract ABIs                                        |
| `.env.example`                      | Environment variable template                        |

## Example Queries

**Recent swaps:**

```graphql
query RecentSwaps {
  SwapEvent(limit: 20, order_by: { blockTimestamp: desc }) {
    id
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

**Trading limits:**

```graphql
query TradingLimits {
  TradingLimit {
    poolId
    token
    limitPressure0
    limitPressure1
    limitStatus
    netflow0
    netflow1
    updatedAtTimestamp
  }
}
```

**Oracle snapshots for a pool:**

```graphql
query OracleHistory($poolId: String!) {
  OracleSnapshot(
    where: { poolId: { _eq: $poolId } }
    order_by: { timestamp: desc }
    limit: 100
  ) {
    timestamp
    oraclePrice
    oraclePriceDenom
    oracleOk
    priceDifference
    rebalanceThreshold
    numReporters
  }
}
```

## Deployment

The indexer deploys via Git push to a deploy branch. Envio watches the branch and auto-redeploys.

Because Envio hosted may build `indexer-envio/` outside the pnpm workspace, the package keeps a committed copy of `deployment-namespaces.json` in `indexer-envio/config/`. The repo test suite verifies that file stays in sync with `shared-config/deployment-namespaces.json`.

> ⚠️ **Each deployment generates a new endpoint URL hash.** Update the Vercel env var after every redeploy. See [`docs/deployment.md`](../docs/deployment.md).

## Known Limitations

- Only one indexer can run locally at a time (port 9898 hardcoded in Envio)
- SortedOracles events are only indexed on mainnet (Sepolia returns zero address for oracle contracts)
- Envio free tier: 100k event soft limit, 30-day expiry — monitor and redeploy before expiry
