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

- `ENVIO_RPC_URL_42220` — Celo Mainnet RPC endpoint (e.g. `https://42220.rpc.hypersync.xyz`)
- `ENVIO_RPC_URL_143` — Monad Mainnet RPC endpoint (e.g. `https://143.rpc.hypersync.xyz`)
- `ENVIO_START_BLOCK_CELO` — (optional) Celo start block, defaults to 60664500
- `ENVIO_START_BLOCK_MONAD` — (optional) Monad start block, defaults to 60730000

Do **not** set the generic `ENVIO_RPC_URL` in multichain mode — it would route all chains to the same endpoint and produce incorrect RPC reads for chain-specific calls.

Mainnet (Celo + Monad): `pnpm indexer:codegen && pnpm indexer:dev`. Testnet (Celo Sepolia + Monad Testnet): `pnpm indexer:testnet:dev`.
