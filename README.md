# Mento Monitoring Monorepo

Real-time monitoring infrastructure for Mento v3 on-chain pools — an [Envio HyperIndex](https://docs.envio.dev/) indexer paired with a Next.js 16 + Plotly.js dashboard.

**Live dashboard:** [monitoring.mento.org](https://monitoring.mento.org)

## Packages

| Package                             | Description                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| [`indexer-envio`](./indexer-envio/) | Envio HyperIndex indexer for Celo Mainnet + Sepolia (FPMM pools + VirtualPools)    |
| [`ui-dashboard`](./ui-dashboard/)   | Next.js 16 + Plotly.js monitoring dashboard with multi-chain network switching      |

## Architecture

```text
┌─────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Celo Chain     │────▶│  Envio HyperIndex │────▶│  Hasura        │
│  (RPC / GRPC)   │     │  (Hosted)         │     │  (GraphQL API) │
└─────────────────┘     └──────────────────┘     └───────┬────────┘
                                                          │
                                                   ┌──────▼──────┐
                                                   │  Next.js    │
                                                   │  Dashboard  │
                                                   │  (Vercel)   │
                                                   └─────────────┘
```

The indexer runs on Envio's hosted free tier. Each deploy produces a new GraphQL endpoint hash. The dashboard reads from this endpoint via Hasura's GraphQL API.

## Networks

| Network        | Chain ID | Status                        |
| -------------- | -------- | ----------------------------- |
| Celo Mainnet   | 42220    | ✅ Live                       |
| Celo Sepolia   | 44787    | ✅ Live                       |
| Monad Mainnet  | —        | ⏳ Blocked on contract deploy |

## Getting Started

### Prerequisites

- Node.js 22 LTS
- [pnpm](https://pnpm.io/) 10.x
- Docker (for local indexer dev — runs Postgres + Hasura)

### Install

```bash
pnpm install
```

### Run the Indexer (local — Celo Sepolia)

```bash
# Generate types from schema + config
pnpm indexer:sepolia:codegen

# Start the indexer (spins up Docker: Postgres + Hasura + indexer)
pnpm indexer:sepolia:dev
```

### Run the Dashboard

```bash
pnpm dashboard:dev
```

The dashboard connects to Hasura (local or hosted) to display real-time pool data.

## Environment Variables

### Indexer

Create `indexer-envio/.env` from `indexer-envio/.env.example`:

| Variable            | Description                  | Default          |
| ------------------- | ---------------------------- | ---------------- |
| `ENVIO_API_TOKEN`   | Envio platform API token     | —                |
| `ENVIO_RPC_URL`     | Celo RPC endpoint            | —                |
| `ENVIO_START_BLOCK` | Block to start indexing from | `60664513`       |

### Dashboard

The dashboard supports multiple network targets via `_<NETWORK>` suffix env vars:

| Variable                                    | Description                                     |
| ------------------------------------------- | ----------------------------------------------- |
| `NEXT_PUBLIC_HASURA_URL_MAINNET_HOSTED`     | Hasura/GraphQL endpoint — Celo Mainnet (hosted) |
| `NEXT_PUBLIC_HASURA_SECRET_MAINNET_HOSTED`  | Hasura admin secret — Celo Mainnet hosted       |
| `NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED`     | Hasura/GraphQL endpoint — Celo Sepolia (hosted) |
| `NEXT_PUBLIC_HASURA_SECRET_SEPOLIA_HOSTED`  | Hasura admin secret — Celo Sepolia hosted       |
| `NEXT_PUBLIC_HASURA_URL_MAINNET`            | Hasura endpoint — Celo Mainnet (local)          |
| `NEXT_PUBLIC_HASURA_SECRET_MAINNET`         | Hasura admin secret — Celo Mainnet (local)      |
| `NEXT_PUBLIC_HASURA_URL_SEPOLIA`            | Hasura endpoint — Celo Sepolia (local)          |
| `NEXT_PUBLIC_HASURA_SECRET_SEPOLIA`         | Hasura admin secret — Celo Sepolia (local)      |
| `NEXT_PUBLIC_EXPLORER_URL_MAINNET`          | Block explorer — Celo Mainnet                   |
| `NEXT_PUBLIC_EXPLORER_URL_SEPOLIA`          | Block explorer — Celo Sepolia                   |

## Deployment

### Indexer → Envio Hosted

Each network has a dedicated deploy branch Envio watches:

| Network      | Deploy Branch         |
| ------------ | --------------------- |
| Celo Mainnet | `deploy/celo-mainnet` |
| Celo Sepolia | `deploy/celo-sepolia` |

Push to trigger a redeploy:

```bash
pnpm deploy:indexer:mainnet
# or
git push origin main:deploy/celo-mainnet
```

> ⚠️ **Endpoint changes on each deploy.** Envio free tier generates a new URL hash per deployment. After redeploying the indexer, update the Vercel env var:
> ```bash
> pnpm update-endpoint:mainnet
> ```

### Dashboard → Vercel

Vercel watches `main` — every push auto-deploys the dashboard. See [`docs/deployment.md`](./docs/deployment.md) for full details.

## CI

GitHub Actions runs on every PR:

- ESLint 10 (no `eslint-config-next` — uses `@eslint/js` + `typescript-eslint` + `@eslint-react`)
- Vitest (53 tests)
- TypeScript typecheck
- Codecov coverage reporting

## Key Files

| What             | Where                                    |
| ---------------- | ---------------------------------------- |
| Indexer schema   | `indexer-envio/schema.graphql`           |
| Event handlers   | `indexer-envio/src/EventHandlers.ts`     |
| Mainnet config   | `indexer-envio/config.celo.mainnet.yaml` |
| Sepolia config   | `indexer-envio/config.celo.sepolia.yaml` |
| Dashboard app    | `ui-dashboard/src/app/`                  |
| Network defs     | `ui-dashboard/src/lib/networks.ts`       |
| GraphQL queries  | `ui-dashboard/src/lib/queries.ts`        |
| Pool type helper | `ui-dashboard/src/lib/tokens.ts`         |
| Deployment guide | `docs/deployment.md`                     |
| Technical spec   | `SPEC.md`                                |
| Roadmap          | `docs/ROADMAP.md`                        |

## Documentation

- [`SPEC.md`](./SPEC.md) — Full technical specification
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — Current state + upcoming work
- [`docs/BACKLOG.md`](./docs/BACKLOG.md) — Detailed task backlog
- [`docs/deployment.md`](./docs/deployment.md) — Deployment guide
- [`indexer-envio/README.md`](./indexer-envio/README.md) — Indexer reference
