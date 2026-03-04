# Mento Monitoring Monorepo

Real-time monitoring infrastructure for Mento v3 on-chain pools — an [Envio HyperIndex](https://docs.envio.dev/) indexer paired with a Next.js + Plotly.js dashboard.

## Packages

| Package                             | Description                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| [`indexer-envio`](./indexer-envio/) | Envio HyperIndex indexer for Celo v3 FPMM pools (devnet + Sepolia configs)     |
| [`ui-dashboard`](./ui-dashboard/)   | Next.js 16 + Plotly.js monitoring dashboard with multi-chain network switching |

## Getting Started

### Prerequisites

- Node.js 22 LTS (≥ 18 required)
- [pnpm](https://pnpm.io/) 10.x
- Docker (for Envio indexer local dev — runs Postgres + Hasura)

### Install

```bash
pnpm install
```

### Run the Indexer (devnet)

```bash
# First-time setup: generate types from the schema
pnpm indexer:codegen

# Start the indexer (spins up Docker containers for Postgres + Hasura)
pnpm indexer:dev
```

### Run the Indexer (Celo Sepolia)

```bash
pnpm indexer:sepolia:codegen
pnpm indexer:sepolia:dev
```

### Run the Dashboard

```bash
pnpm dashboard:dev
```

The dashboard connects to Hasura (exposed by the indexer) to display real-time pool data.

## Environment Variables

### Indexer

Create `indexer-envio/.env` from `indexer-envio/.env.example`:

| Variable            | Description                  | Default                             |
| ------------------- | ---------------------------- | ----------------------------------- |
| `ENVIO_API_TOKEN`   | Envio platform API token     | —                                   |
| `ENVIO_RPC_URL`     | Celo RPC endpoint            | `http://34.32.123.41:8545` (devnet) |
| `ENVIO_START_BLOCK` | Block to start indexing from | `60548751`                          |

### Dashboard

| Variable                            | Description                              |
| ----------------------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_HASURA_URL_DEVNET`     | Hasura GraphQL endpoint for Celo devnet  |
| `NEXT_PUBLIC_HASURA_URL_SEPOLIA`    | Hasura GraphQL endpoint for Celo Sepolia |
| `NEXT_PUBLIC_HASURA_SECRET_DEVNET`  | Hasura admin secret (devnet)             |
| `NEXT_PUBLIC_HASURA_SECRET_SEPOLIA` | Hasura admin secret (Sepolia)            |
| `NEXT_PUBLIC_EXPLORER_URL_DEVNET`   | Block explorer URL for devnet            |
| `NEXT_PUBLIC_EXPLORER_URL_SEPOLIA`  | Block explorer URL for Sepolia           |

## Deployment

**Indexer:** Envio Hosted Service (dedicated deploy branches per network)  
**Dashboard:** Vercel (auto-deploys from `main` branch)

See **[docs/deployment.md](./docs/deployment.md)** for full deployment guide including:
- Deploy branch strategy for indexer (avoids unnecessary redeployments)
- Envio hosted setup per network
- Vercel configuration
- Environment variables reference

**Quick deploy:**
```bash
# Deploy indexer to Celo Sepolia
pnpm deploy:indexer:sepolia

# Dashboard auto-deploys on push to main (Vercel)
```

## Architecture

```text
┌─────────────┐     ┌──────────┐     ┌─────────────┐
│ Celo Chain   │────▶│  Envio   │────▶│  Hasura     │
│ (RPC)        │     │ Indexer  │     │  (GraphQL)  │
└─────────────┘     └──────────┘     └──────┬──────┘
                                            │
                                     ┌──────▼──────┐
                                     │  Next.js    │
                                     │  Dashboard  │
                                     └─────────────┘
```
