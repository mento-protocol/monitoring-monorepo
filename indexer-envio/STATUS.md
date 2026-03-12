# Indexer Status

Last updated: 2026-03-06

## Current State

Both mainnet and Sepolia indexers are live and synced on Envio's hosted service.

| Network      | Envio Project           | Status     | Sync |
| ------------ | ----------------------- | ---------- | ---- |
| Celo Mainnet | `mento-v3-celo-mainnet` | ✅ Live    | 100% |
| Celo Sepolia | `mento-v3-celo-sepolia` | ✅ Live    | 100% |
| Monad        | —                       | ⏳ Blocked | —    |

## GraphQL Endpoint

Mainnet uses the Envio production tier with a **static** endpoint (hash does not change on redeploy):

```text
https://indexer.hyperindex.xyz/60ff18c/v1/graphql
```

The current URL is stored as `NEXT_PUBLIC_HASURA_URL_CELO_MAINNET_HOSTED` in Vercel project settings.

> Only update the Vercel env var if the indexer is redeployed and Envio issues a new endpoint.

## Schema (as of 2026-03-05)

Full schema: [`schema.graphql`](./schema.graphql)

### Entities

| Entity               | Count (approx, mainnet) | Notes                                    |
| -------------------- | ----------------------- | ---------------------------------------- |
| Pool                 | ~16 (4 FPMM + VPs)      | One per pool, mutable state              |
| PoolSnapshot         | Growing                 | Hourly buckets per pool                  |
| OracleSnapshot       | Growing                 | Per SortedOracles event (mainnet only)   |
| TradingLimit         | ~4–8                    | One per pool per token (FPMM pools only) |
| SwapEvent            | Growing                 | Immutable event log                      |
| LiquidityEvent       | Growing                 | Mint/burn events                         |
| ReserveUpdate        | Growing                 | Per UpdateReserves event                 |
| RebalanceEvent       | Growing                 | Per Rebalanced event                     |
| FactoryDeployment    | ~4 (FPMM) + VPs         | Pool creation events                     |
| VirtualPoolLifecycle | Growing                 | VirtualPool deploy/deprecate events      |

### Key Pool Fields (current schema)

```graphql
type Pool {
  id: ID!
  token0: String
  token1: String
  source: String! # "fpmm" | "virtual"
  reserves0: BigInt!
  reserves1: BigInt!
  swapCount: Int!
  notionalVolume0: BigInt!
  notionalVolume1: BigInt!
  rebalanceCount: Int!
  oracleOk: Boolean!
  oraclePrice: BigInt!
  oraclePriceDenom: BigInt!
  oracleTimestamp: BigInt!
  oracleExpiry: BigInt!
  oracleNumReporters: Int!
  referenceRateFeedID: String!
  priceDifference: BigInt!
  rebalanceThreshold: Int!
  lastRebalancedAt: BigInt!
  healthStatus: String! # "OK" | "WARN" | "CRITICAL" | "N/A"
  limitStatus: String! # "OK" | "WARN" | "CRITICAL" | "N/A"
  limitPressure0: String!
  limitPressure1: String!
  rebalancerAddress: String!
  rebalanceLivenessStatus: String! # "ACTIVE" | "N/A"
  createdAtBlock: BigInt!
  createdAtTimestamp: BigInt!
  updatedAtBlock: BigInt!
  updatedAtTimestamp: BigInt!
}
```

## Config Files

| File                       | Start Block | Networks       |
| -------------------------- | ----------- | -------------- |
| `config.celo.mainnet.yaml` | 60664513    | Celo Mainnet   |
| `config.celo.sepolia.yaml` | (Sepolia)   | Celo Sepolia   |
| `config.celo.devnet.yaml`  | 60548751    | DevNet (local) |

## Contracts Indexed (Mainnet)

| Contract        | Address                                      |
| --------------- | -------------------------------------------- |
| FPMMFactory     | `0xa849b475FE5a4B5C9C3280152c7a1945b907613b` |
| Router          | `0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6` |
| OracleAdapter   | `0xa472fBBF4b890A54381977ac392BdF82EeC4383a` |
| SortedOracles   | `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33` |
| FPMM pools (×4) | See README.md                                |

## What's Not Yet Indexed

- Liquity v2 CDP contracts (TroveManager, StabilityPool) — Phase 2
- Monad mainnet — blocked on contract deployment
- Historical pre-start-block events (Envio `onBlock` lacks timestamps for backfill)

## Local Dev

See [`README.md`](./README.md#local-development) for setup instructions.

Quick start:

```bash
pnpm indexer:celo-sepolia:codegen
pnpm indexer:celo-sepolia:dev
# Hasura: http://localhost:8080 (secret: testing)
```
