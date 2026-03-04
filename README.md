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

The dashboard supports five network targets. Each uses a `_<NETWORK>` suffix on the env var name:

| Variable                                   | Default                            | Description                               |
| ------------------------------------------ | ---------------------------------- | ----------------------------------------- |
| `NEXT_PUBLIC_HASURA_URL_DEVNET`            | `http://localhost:8080/v1/graphql` | Hasura endpoint — Celo Devnet (local)     |
| `NEXT_PUBLIC_HASURA_SECRET_DEVNET`         | `"testing"`                        | Hasura admin secret — Celo Devnet         |
| `NEXT_PUBLIC_EXPLORER_URL_DEVNET`          | `http://localhost:5100`            | Block explorer URL — Celo Devnet          |
| `NEXT_PUBLIC_HASURA_URL_SEPOLIA`           | `http://localhost:8080/v1/graphql` | Hasura endpoint — Celo Sepolia (local)    |
| `NEXT_PUBLIC_HASURA_SECRET_SEPOLIA`        | `"testing"`                        | Hasura admin secret — Celo Sepolia        |
| `NEXT_PUBLIC_EXPLORER_URL_SEPOLIA`         | `https://sepolia.celoscan.io`      | Block explorer URL — Celo Sepolia         |
| `NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED`    | —                                  | Hasura endpoint — Celo Sepolia (hosted)   |
| `NEXT_PUBLIC_HASURA_SECRET_SEPOLIA_HOSTED` | —                                  | Hasura admin secret — Celo Sepolia hosted |
| `NEXT_PUBLIC_HASURA_URL_MAINNET`           | `http://localhost:8082/v1/graphql` | Hasura endpoint — Celo Mainnet (local)    |
| `NEXT_PUBLIC_HASURA_SECRET_MAINNET`        | `"testing"`                        | Hasura admin secret — Celo Mainnet        |
| `NEXT_PUBLIC_HASURA_URL_MAINNET_HOSTED`    | —                                  | Hasura endpoint — Celo Mainnet (hosted)   |
| `NEXT_PUBLIC_HASURA_SECRET_MAINNET_HOSTED` | —                                  | Hasura admin secret — Celo Mainnet hosted |

## Deployment

The dashboard is configured for **Vercel** deployment. See [`ui-dashboard/vercel.json`](./ui-dashboard/vercel.json).

Set all `NEXT_PUBLIC_*` environment variables in the Vercel project settings.

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
