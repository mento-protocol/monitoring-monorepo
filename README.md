# Mento Monitoring Monorepo

Real-time monitoring infrastructure for Mento v3 on-chain pools — a multichain [Envio HyperIndex](https://docs.envio.dev/) indexer paired with a Next.js 16 + Plotly.js dashboard.

**Live dashboard:** [monitoring.mento.org](https://monitoring.mento.org)

## Packages

| Package                               | Description                                                         |
| ------------------------------------- | ------------------------------------------------------------------- |
| [`indexer-envio`](./indexer-envio/)   | Envio HyperIndex indexer — Celo + Monad multichain                  |
| [`ui-dashboard`](./ui-dashboard/)     | Next.js 16 + Plotly.js dashboard with multi-chain network switching |
| [`metrics-bridge`](./metrics-bridge/) | Hasura → Prometheus exporter for v3 alert rules                     |
| [`shared-config`](./shared-config/)   | Shared deployment config (chain ID → treb namespace mappings)       |
| [`aegis`](./aegis/)                   | App Engine v2 alerting service + Grafana dashboards/alerts          |

## Architecture

```text
┌──────────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Celo + Monad Chains │────▶│  Envio HyperIndex │────▶│  Hasura        │
│  (HyperSync / RPC)   │     │  (Hosted, mento)  │     │  (GraphQL API) │
└──────────────────────┘     └──────────────────┘     └───────┬────────┘
                                                               │
                                                        ┌──────▼──────┐
                                                        │  Next.js    │
                                                        │  Dashboard  │
                                                        │  (Vercel)   │
                                                        └─────────────┘
```

Both Celo Mainnet (42220) and Monad Mainnet (143) are served from a single Envio project (`mento`) using `config.multichain.mainnet.yaml`. Pool IDs are namespaced as `{chainId}-{address}` to prevent cross-chain collisions.

**Static production endpoint:** `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql`

## Networks

| Network       | Chain ID | Status                                         |
| ------------- | -------- | ---------------------------------------------- |
| Celo Mainnet  | 42220    | Live in the production multichain indexer      |
| Monad Mainnet | 143      | Live in the production multichain indexer      |
| Celo Sepolia  | 11142220 | Local/testnet config available, not production |
| Monad Testnet | 10143    | Local/testnet config available, not production |

## Getting Started

### Prerequisites

- Node.js 22 LTS
- [pnpm](https://pnpm.io/) 10.x
- Docker (for local indexer dev — runs Postgres + Hasura)

### Install

For a fresh clone or worktree, prefer the setup script so workspace deps,
postinstall hooks, and Envio codegen all run in one place:

```bash
./scripts/setup.sh
```

If you install manually, verify the dashboard can resolve its Sentry package
after `pnpm install`:

```bash
pnpm install
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"
```

> **Supply-chain gate:** `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`
> (3 days), so pnpm refuses to resolve registry versions younger than 3
> days. Frozen-lockfile installs (CI, `./scripts/setup.sh`) are unaffected.
> If you hit `ERR_PNPM_PACKAGE_TOO_YOUNG` — during `pnpm add`, a
> lockfile-updating `pnpm install`, or `pnpm update` — pin to a slightly
> older version or wait out the gate. For urgent CVE patches that need a
> brand-new release immediately, override per-invocation by appending
> `--config.minimumReleaseAge=0` to the failing command (e.g.
> `pnpm add --config.minimumReleaseAge=0 <pkg>` or
> `pnpm update --config.minimumReleaseAge=0 <pkg>`). `@mento-protocol/*`
> is exempted so our own releases install same-day.

### Run the Indexer (local)

```bash
# Multichain mainnet (Celo + Monad) — default
pnpm indexer:codegen && pnpm indexer:dev

# Multichain testnet (Celo Sepolia + Monad testnet)
pnpm indexer:testnet:codegen && pnpm indexer:testnet:dev
```

### Run the Dashboard

```bash
pnpm dashboard:dev
```

### Run Aegis

```bash
pnpm aegis:dev
pnpm aegis:typecheck
pnpm aegis:test
```

Aegis remains the NestJS App Engine service in `mento-prod`; the monorepo
operator interface is the root `pnpm aegis:*` command family.

### Dashboard Browser Tests

```bash
pnpm --filter @mento-protocol/ui-dashboard test:browser
```

The browser suite starts the Next.js app with a local GraphQL fixture server so
it can exercise routing, focus, hydration, and degraded query states without
hitting hosted Hasura/Envio. The agent quality gate installs Playwright
Chromium before running it; for direct fresh-checkout runs, install it once with
`pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium`.

### Targeted Mutation Baseline

```bash
pnpm indexer:mutation
pnpm dashboard:mutation
pnpm bridge:mutation
```

These run the non-required StrykerJS baselines for targeted indexer, dashboard,
and metrics-bridge pure logic. See
[`docs/mutation-testing.md`](./docs/mutation-testing.md) for scope, runtime,
score, and survivor classification.

For unused-code discovery across all packages (report-only, doesn't exit non-zero), run:

```bash
pnpm code-health:knip:report
```

For a strict run that fails on unused files / unlisted deps (the same gate CI runs):

```bash
pnpm code-health:knip
```

## Environment Variables

### Indexer

Create `indexer-envio/.env` from `indexer-envio/.env.example`:

| Variable                           | Description                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ENVIO_RPC_URL_42220`              | Celo Mainnet primary RPC endpoint                                                                              |
| `ENVIO_RPC_URL_143`                | Monad Mainnet primary RPC endpoint                                                                             |
| `ENVIO_RPC_FALLBACK_URL_<chainId>` | (optional) per-chain fallback RPC for archive-depth + rate-limit failover (see `indexer-envio/AGENTS.md`)      |
| `ENVIO_START_BLOCK_CELO`           | Celo start block (default: 60664500)                                                                           |
| `ENVIO_START_BLOCK_MONAD`          | Monad start block (default: 60710000)                                                                          |
| `INDEXER_PERF`                     | Optional indexer sync profiler; set to `1` to log handler/effect/entity counters during local or debug replays |
| `INDEXER_PERF_LOG_INTERVAL_EVENTS` | Optional profiler log interval in processed handler calls (default: 10000)                                     |

### Dashboard

| Variable                                 | Description                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_HASURA_URL`                 | Prod Envio GraphQL endpoint (shared by Celo + Monad mainnet, filtered by chainId)                          |
| `HASURA_SECRET_DEVNET`                   | Optional server-only admin secret for `/api/hasura/devnet` proxy                                           |
| `HASURA_SECRET_CELO_SEPOLIA_LOCAL`       | Optional server-only admin secret for `/api/hasura/celo-sepolia-local` proxy                               |
| `HASURA_SECRET_CELO_MAINNET_LOCAL`       | Optional server-only admin secret for `/api/hasura/celo-mainnet-local` proxy                               |
| `HASURA_UPSTREAM_URL_DEVNET`             | Optional upstream URL override for local devnet Hasura proxy (default `http://localhost:8080/v1/graphql`)  |
| `HASURA_UPSTREAM_URL_CELO_SEPOLIA_LOCAL` | Optional upstream URL override for local sepolia Hasura proxy (default `http://localhost:8080/v1/graphql`) |
| `HASURA_UPSTREAM_URL_CELO_MAINNET_LOCAL` | Optional upstream URL override for local mainnet Hasura proxy (default `http://localhost:8080/v1/graphql`) |
| `UPSTASH_REDIS_REST_URL`                 | Address labels storage (Upstash Redis)                                                                     |
| `UPSTASH_REDIS_REST_TOKEN`               | Address labels Redis auth token                                                                            |
| `BLOB_READ_WRITE_TOKEN`                  | Vercel Blob token for daily label backups                                                                  |

Production env vars are managed by Terraform. See [`terraform/`](./terraform/).

## Deployment

### Indexer → Envio Hosted

Push to the `envio` branch to trigger a hosted reindex:

```bash
COMMIT=$(git rev-parse HEAD)
pnpm deploy:indexer
pnpm deploy:indexer:status "$COMMIT" --watch
pnpm deploy:indexer:promote "$COMMIT"
```

The `mento` project on [Envio Cloud](https://envio.dev/app/mento-protocol/mento) watches this branch.

### Aegis → App Engine

```bash
pnpm aegis:build
pnpm aegis:typecheck
pnpm aegis:deploy   # builds, then deploys to App Engine in mento-prod
pnpm aegis:logs
```

Grafana dashboards and v2 alert rules live in `aegis/terraform` and keep the
existing GCS backend prefix `aegis`:

```bash
pnpm aegis:tf:init
pnpm aegis:tf:plan
pnpm aegis:tf:apply
```

Never run Terraform apply without reviewing the plan first.

### Dashboard → Vercel

Every push to `main` that touches `ui-dashboard/` auto-deploys to [monitoring.mento.org](https://monitoring.mento.org).

Infrastructure (Vercel project, env vars, Upstash Redis) is managed by Terraform:

```bash
pnpm infra:plan    # preview changes
pnpm infra:apply   # apply changes
```

## Contract Addresses

Sourced from the published [`@mento-protocol/contracts`](https://www.npmjs.com/package/@mento-protocol/contracts) npm package. The active treb deployment namespace per chain is declared in [`shared-config/deployment-namespaces.json`](./shared-config/deployment-namespaces.json).

## Key Files

| What                      | Where                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| Indexer schema            | `indexer-envio/schema.graphql`                                                   |
| Event handlers            | `indexer-envio/src/EventHandlers.ts`                                             |
| Pool ID helpers           | `indexer-envio/src/helpers.ts`                                                   |
| Multichain config         | `indexer-envio/config.multichain.mainnet.yaml`                                   |
| Indexer status + endpoint | `indexer-envio/STATUS.md`                                                        |
| Dashboard app             | `ui-dashboard/src/app/`                                                          |
| Network defs              | `ui-dashboard/src/lib/networks.ts`                                               |
| GraphQL queries           | `ui-dashboard/src/lib/queries.ts` (barrel) + `ui-dashboard/src/lib/queries/*.ts` |
| Terraform infrastructure  | `terraform/`                                                                     |

## Documentation

- [`indexer-envio/README.md`](./indexer-envio/README.md) — Indexer reference
- [`indexer-envio/STATUS.md`](./indexer-envio/STATUS.md) — Current sync state + endpoint
- [`docs/deployment.md`](./docs/deployment.md) — Full deployment guide
