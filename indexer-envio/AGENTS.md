# AGENTS.md — Envio Indexer

## What This Is

Envio HyperIndex indexer for Mento v3 FPMM (Fixed Product Market Maker) pools on Celo + Monad (multichain).

## Before Opening PRs

If your indexer change propagates into Hasura/UI behavior — schema changes, entity additions, new fields on existing entities, degraded RPC/error handling, or any stateful dashboard behavior fed by indexer data — read and apply:

- `../docs/pr-checklists/stateful-data-ui.md`

This is mandatory for cross-layer/stateful data work. Do not assume the UI/query layer will “just catch up” later.

## Key Files

- `config.multichain.mainnet.yaml` — **Default** mainnet config (Celo + Monad)
- `config.multichain.testnet.yaml` — Testnet multichain config
- `schema.graphql` — Entity definitions (FPMM, Swap, Mint, Burn, UpdateReserves, Rebalanced)
- `src/EventHandlers.ts` — Event processing logic
- `src/contractAddresses.ts` — Contract address resolution from `@mento-protocol/contracts`; also exports `CONTRACT_NAMESPACE_BY_CHAIN` (backed by `config/deployment-namespaces.json`)
- `config/deployment-namespaces.json` — Vendored copy of the chain ID → active namespace map used by Envio hosted builds
- `scripts/run-envio-with-env.mjs` — Wrapper that loads .env before running envio CLI
- `abis/` — Contract ABIs (FPMMFactory, FPMM, VirtualPoolFactory); SortedOracles + token ABIs come from `@mento-protocol/contracts`

## Commands

```bash
pnpm codegen   # Generate types from schema + config
pnpm dev       # Start indexer in dev mode (Docker: Postgres + Hasura)
pnpm start     # Start in production mode
pnpm stop      # Stop Docker containers
pnpm test      # Run tests (mocha + chai)
```

## How It Works

1. Envio connects to Celo RPC and listens for events from configured contracts
2. Events are processed by `EventHandlers.ts` and stored in Postgres
3. Hasura auto-generates a GraphQL API over the Postgres tables
4. The dashboard queries Hasura for pool data

## Contract Types

- **FPMMFactory** — Deploys new FPMM pools
- **FPMM** — Fixed Product Market Maker pools (Swap, Mint, Burn, UpdateReserves, Rebalanced events)
- **VirtualPoolFactory** — Deploys virtual pools
- **VirtualPool** — Virtual pool instances (same event set as FPMM)

## Dependencies

- **`@mento-protocol/contracts`** — Contract ABIs and addresses (published npm package).
- **`config/deployment-namespaces.json`** — Vendored namespace map for Envio hosted compatibility; keep it in sync with `../shared-config/deployment-namespaces.json`.
- **`viem`** — Used for RPC calls (oracle reporter count via `readContract`).

## Environment

Copy `.env.example` → `.env` and set:

- `ENVIO_API_TOKEN` — required only for chains that default to HyperRPC (currently only Monad Testnet 10143). Not needed for mainnet if using the full-node defaults. ([create token](https://envio.dev/app/api-tokens))
- `ENVIO_RPC_URL_42220` — (optional) Celo Mainnet RPC override (default: `https://forno.celo.org`)
- `ENVIO_RPC_URL_143` — (optional) Monad Mainnet RPC override (default: `https://rpc2.monad.xyz`)
- `ENVIO_RPC_URL_10143` — (optional) Monad Testnet RPC override (default: HyperRPC — requires `ENVIO_API_TOKEN`)
- `ENVIO_START_BLOCK_CELO` — (optional) Celo start block, defaults to 60664500
- `ENVIO_START_BLOCK_MONAD` — (optional) Monad start block, defaults to 60710000

Do **not** set the generic `ENVIO_RPC_URL` in multichain mode — it would route all chains to the same endpoint and produce incorrect RPC reads for chain-specific calls.

> **Note:** These RPC URLs are only used for contract reads (`eth_call`). Envio's event syncing uses HyperSync, configured in the YAML files.

Mainnet (Celo + Monad): `pnpm indexer:codegen && pnpm indexer:dev`. Testnet (Celo Sepolia + Monad Testnet): `pnpm indexer:testnet:dev`.

## Indexer patterns the bots keep catching

These rules come from PRs #184 and #194 — Codex flagged both as P1.

### Composite IDs MUST be collision-resistant

- A composite ID built from `entityId + timestamp(seconds)` is **insufficient**. Two events in the same block (or adjacent blocks with identical timestamps) get the same ID; the second write silently overwrites the first
- Always include enough block-level entropy: `chainId + blockNumber + logIndex` is the minimum, or `txHash + logIndex` if you need cross-chain uniqueness
- Specifically: any "transition" entity (breach open/close, reserve update, status change) keyed solely on the parent entity + a coarse timestamp will lose history under bursts

### Cumulative counters belong on the entity

- Lifetime aggregates (cumulative critical seconds, total breach count, cumulative volume) MUST be incremented in handlers and stored on the entity, NOT computed client-side from a paginated list
- The dashboard reads from hosted Hasura which silently caps every query at 1000 rows; client-side aggregation will drop history for any active pool
- Pattern: when you add a new "incident" entity, also add a counter field on the parent entity and increment it in the close-path handler

### Time units

- FX-pool metrics use **trading-seconds** (weekend subtracted). Any duration field on a healthscore-related entity MUST be in trading-seconds
- Never store wall-clock durations alongside trading-second durations on the same entity — readers will mix them and produce nonsense
- The shared FX calendar lives in `shared-config/fx-calendar.json` so the indexer and UI stay in lockstep

### Bounded RPC caches

- Block-keyed RPC caches (oracle reads, etc.) MUST be size-bounded. PR #184 fixed an OOM where the indexer cached one entry per block forever
- Use an LRU or evict on block height advance; never an unbounded `Map`

### Cross-checks before opening a PR

- Run the queries the dashboard depends on against your local Hasura with a representative pool (one with hundreds of events) to catch silent truncation
- Verify any new entity ID under the same-block-write scenario before merging
