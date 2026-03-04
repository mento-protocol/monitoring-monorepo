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

## Envio Gotchas

### Hasura must run on port 8080

The envio binary hardcodes `http://localhost:8080/hasura/healthz?strict=true` for its startup liveness check. This port is not configurable via env vars. **Never set `HASURA_EXTERNAL_PORT` to anything other than 8080** (or omit it entirely) — the binary will silently fail its health check and retry with exponential backoff, stalling startup for 5+ minutes per attempt.

### Only one local indexer at a time

All envio configs share the same Docker project name (`generated`, derived from the `generated/` directory name) and the same Hasura port (8080). Running two local indexers simultaneously will cause container name conflicts. Start one, stop it, then start the other.

### Postgres healthcheck is auto-patched after codegen

The envio-generated `generated/docker-compose.yaml` does not include a healthcheck for the postgres service. Without one, Docker reports `Health:""` and the envio binary waits indefinitely. `scripts/run-envio-with-env.mjs` automatically patches the file to add a `pg_isready` healthcheck after every `pnpm codegen` run. If you regenerate the compose file manually, re-run codegen via the script (not directly via `envio codegen`) to re-apply the patch.

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
