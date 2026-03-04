# AGENTS.md — Monitoring Monorepo

## Overview

pnpm monorepo with two packages:

- `indexer-envio/` — Envio HyperIndex indexer for Celo v3 FPMM pools
- `ui-dashboard/` — Next.js 16 + Plotly.js monitoring dashboard

## Quick Commands

```bash
# Install all deps
pnpm install

# Indexer
pnpm indexer:codegen          # Generate types from schema
pnpm indexer:dev              # Start indexer (devnet)
pnpm indexer:sepolia:codegen  # Generate types (sepolia config)
pnpm indexer:sepolia:dev      # Start indexer (sepolia)

# Dashboard
pnpm dashboard:dev            # Dev server
pnpm dashboard:build          # Production build
```

## Package Details

### indexer-envio

- **Runtime:** Envio HyperIndex (envio@2.32.3)
- **Schema:** `schema.graphql` defines indexed entities (FPMM, Swap, Mint, Burn, etc.)
- **Config:** `config.yaml` (devnet), `config.sepolia.yaml` (Celo Sepolia testnet)
- **Handlers:** `src/EventHandlers.ts` — processes blockchain events
- **ABIs:** `abis/` — FPMMFactory, FPMM, VirtualPoolFactory
- **Scripts:** `scripts/run-envio-with-env.mjs` — loads .env and runs envio CLI
- **Tests:** `test/` — mocha + chai
- **Docker:** Envio dev mode spins up Postgres + Hasura automatically

### ui-dashboard

- **Framework:** Next.js 16 (App Router, React 19)
- **Charts:** Plotly.js via react-plotly.js
- **Data:** GraphQL queries to Hasura (via graphql-request + SWR)
- **Styling:** Tailwind CSS 4
- **Multi-chain:** Network selector switches between devnet/sepolia Hasura endpoints
- **Addresses:** `src/lib/addresses.json` — contract address book for all networks
- **Deployment:** Vercel (see `vercel.json`)

## File Structure

```text
monitoring-monorepo/
├── package.json              # Root workspace config
├── pnpm-workspace.yaml       # Workspace package list
├── indexer-envio/
│   ├── config.yaml           # Devnet indexer config
│   ├── config.sepolia.yaml   # Sepolia indexer config
│   ├── schema.graphql        # Entity definitions
│   ├── src/EventHandlers.ts  # Event processing logic
│   ├── abis/                 # Contract ABIs
│   ├── scripts/              # Helper scripts
│   └── test/                 # Tests
└── ui-dashboard/
    ├── src/
    │   ├── app/              # Next.js App Router pages
    │   └── lib/              # Data fetching, addresses
    ├── public/               # Static assets
    ├── vercel.json           # Vercel deployment config
    └── next.config.ts        # Next.js config
```

## Environment

- Indexer needs Docker for local dev (Postgres + Hasura containers)
- Dashboard needs `NEXT_PUBLIC_HASURA_URL_*` and `NEXT_PUBLIC_HASURA_SECRET_*` env vars
- See root README.md for full env var documentation

## Common Tasks

### Adding a new contract to index

1. Add ABI to `indexer-envio/abis/`
2. Add contract entry in `config.yaml` (and `config.sepolia.yaml` if applicable)
3. Add entity to `schema.graphql`
4. Add handler in `src/EventHandlers.ts`
5. Run `pnpm indexer:codegen` to regenerate types

### Adding a new chart to the dashboard

1. Create component in `ui-dashboard/src/`
2. Add GraphQL query for the data
3. Wire up with SWR for real-time updates
