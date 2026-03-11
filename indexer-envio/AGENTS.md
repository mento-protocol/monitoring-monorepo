# AGENTS.md — Envio Indexer

## What This Is

Envio HyperIndex indexer for Mento v3 FPMM (Fixed Product Market Maker) pools on Celo.

## Key Files

- `config.celo.devnet.yaml` — Devnet indexer config (contract addresses, events, RPC)
- `config.celo.mainnet.yaml` — Celo Mainnet config
- `config.celo.sepolia.yaml` — Celo Sepolia testnet config
- `schema.graphql` — Entity definitions (FPMM, Swap, Mint, Burn, UpdateReserves, Rebalanced)
- `src/EventHandlers.ts` — Event processing logic
- `src/contractAddresses.ts` — Contract address resolution from `@mento-protocol/contracts`; also exports `CONTRACT_NAMESPACE_BY_CHAIN` (backed by `shared-config`)
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

- **`@mento-protocol/contracts`** — Contract ABIs and addresses (published npm package). The active namespace per chain is in `../shared-config/deployment-namespaces.json`.
- **`@mento-protocol/monitoring-config`** — Shared workspace package; provides `deployment-namespaces.json`.
- **`viem`** — Used for RPC calls (oracle reporter count via `readContract`).

## Environment

Copy `.env.example` → `.env` and set:

- `ENVIO_API_TOKEN` — Get from <https://envio.dev/app/api-tokens>
- `ENVIO_RPC_URL` — Celo RPC endpoint
- `ENVIO_START_BLOCK` — Block number to start indexing from

For Sepolia: copy `.env.sepolia` → `.env` or use root `pnpm indexer:sepolia:dev`.
