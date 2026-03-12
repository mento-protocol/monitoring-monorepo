# AGENTS.md — Monitoring Monorepo

## Overview

pnpm monorepo with three packages:

- `shared-config/` — `@mento-protocol/monitoring-config`: shared deployment config (chain ID → treb namespace mapping)
- `indexer-envio/` — Envio HyperIndex indexer for Celo v3 FPMM pools
- `ui-dashboard/` — Next.js 16 + Plotly.js monitoring dashboard

## Quick Commands

```bash
# Install all deps
pnpm install

# Indexer
pnpm indexer:codegen              # Generate types from schema (devnet)
pnpm indexer:dev                   # Start indexer (devnet)
pnpm indexer:celo-sepolia:codegen  # Generate types (Celo Sepolia config)
pnpm indexer:celo-sepolia:dev     # Start indexer (Celo Sepolia)
pnpm indexer:celo-mainnet:codegen  # Generate types (Celo mainnet)
pnpm indexer:celo-mainnet:dev      # Start indexer (Celo mainnet)
pnpm indexer:monad-mainnet:codegen  # Generate types (Monad mainnet)
pnpm indexer:monad-mainnet:dev      # Start indexer (Monad mainnet)
pnpm indexer:monad-testnet:codegen  # Generate types (Monad testnet)
pnpm indexer:monad-testnet:dev      # Start indexer (Monad testnet)

# Dashboard
pnpm dashboard:dev            # Dev server
pnpm dashboard:build          # Production build

# Infrastructure (Terraform)
pnpm infra:init               # Init providers (first time or after changes)
pnpm infra:plan               # Preview infrastructure changes
pnpm infra:apply              # Apply infrastructure changes
```

## Package Details

### shared-config

- **Package:** `@mento-protocol/monitoring-config` (private, no build step)
- **Purpose:** Single source of truth for chain ID → active treb namespace. Edit `deployment-namespaces.json` when promoting a new deployment.
- **Consumed by:** both `indexer-envio` and `ui-dashboard` via `workspace:*` dependency

### indexer-envio

- **Runtime:** Envio HyperIndex (envio@2.32.3)
- **Schema:** `schema.graphql` defines indexed entities (FPMM, Swap, Mint, Burn, etc.)
- **Configs:** `config.celo.devnet.yaml`, `config.celo.mainnet.yaml`, `config.celo.sepolia.yaml`, `config.monad.mainnet.yaml`, `config.monad.testnet.yaml`
- **Handlers:** `src/EventHandlers.ts` — processes blockchain events
- **Contract addresses:** `src/contractAddresses.ts` — resolves addresses from `@mento-protocol/contracts` using the namespace map from `shared-config`
- **ABIs:** `abis/` — FPMMFactory, FPMM, VirtualPoolFactory (indexer-specific); SortedOracles + token ABIs come from `@mento-protocol/contracts`
- **Scripts:** `scripts/run-envio-with-env.mjs` — loads .env and runs envio CLI
- **Tests:** `test/` — mocha + chai
- **Docker:** Envio dev mode spins up Postgres + Hasura automatically

### ui-dashboard

- **Framework:** Next.js 16 (App Router, React 19)
- **Charts:** Plotly.js via react-plotly.js
- **Data:** GraphQL queries to Hasura (via graphql-request + SWR)
- **Styling:** Tailwind CSS 4
- **Multi-chain:** Network selector switches between celo-mainnet, celo-sepolia, monad-mainnet, monad-testnet Hasura endpoints; all networks defined in `src/lib/networks.ts`
- **Contract labels:** `src/lib/networks.ts` derives token symbols and address labels from `@mento-protocol/contracts` (no vendored JSON); the active namespace per chain comes from `shared-config`
- **Address book:** `/address-book` page + inline editing; custom labels stored in Upstash Redis, backed up daily to Vercel Blob; custom labels override/extend the package-derived ones
- **Deployment:** Vercel (`monitoring-dashboard` project); infra managed by Terraform in `terraform/`

### PR Review Guidance (Dashboard Scale)

- Current expected scale is roughly **30–50 total pools**.
- At this size, client-side aggregation for the 24h volume tiles/table is acceptable with the current polling setup.
- Do **not** flag the current snapshot-query aggregation path as a scalability issue in PR reviews unless assumptions change materially (e.g. significantly more pools, much higher polling frequency, or observed latency/cost regressions in production).

## File Structure

```text
monitoring-monorepo/
├── package.json              # Root workspace config
├── pnpm-workspace.yaml       # Workspace package list
├── terraform/                # Terraform — Vercel project + Upstash Redis + env vars
│   ├── main.tf               # All resources
│   ├── variables.tf          # Input variables
│   ├── outputs.tf            # Outputs (project ID, Redis URL, etc.)
│   ├── terraform.tfvars.example  # Template (copy to terraform.tfvars)
│   └── .gitignore            # Ignores tfstate, tfvars, .terraform/
├── shared-config/            # @mento-protocol/monitoring-config (private)
│   ├── package.json
│   └── deployment-namespaces.json  # ← edit this when promoting a new deployment
├── indexer-envio/
│   ├── config.celo.devnet.yaml   # Devnet indexer config
│   ├── config.celo.mainnet.yaml  # Celo Mainnet config
│   ├── config.celo.sepolia.yaml  # Celo Sepolia config
│   ├── config.monad.mainnet.yaml # Monad Mainnet config
│   ├── config.monad.testnet.yaml # Monad Testnet config
│   ├── schema.graphql        # Entity definitions
│   ├── src/
│   │   ├── EventHandlers.ts  # Event processing logic
│   │   └── contractAddresses.ts  # Contract address resolution from @mento-protocol/contracts
│   ├── abis/                 # Contract ABIs (FPMMFactory, FPMM, VirtualPoolFactory)
│   ├── scripts/              # Helper scripts
│   └── test/                 # Tests
└── ui-dashboard/
    ├── src/
    │   ├── app/
    │   │   ├── address-book/ # Address book page
    │   │   └── api/address-labels/  # CRUD + export/import/backup routes
    │   ├── components/
    │   │   ├── address-label-editor.tsx   # Inline edit dialog
    │   │   └── address-labels-provider.tsx  # Context: merges package + custom labels
    │   └── lib/
    │       ├── address-labels.ts  # Upstash Redis data access (server-side)
    │       └── networks.ts        # Network defs; derives labels from @mento-protocol/contracts
    ├── public/               # Static assets
    ├── vercel.json           # Vercel config + daily backup cron
    └── next.config.ts        # Next.js config
```

## Environment

- Indexer needs Docker for local dev (Postgres + Hasura containers)
- Dashboard needs `NEXT_PUBLIC_HASURA_URL_*` env vars for local dev; run `vercel env pull ui-dashboard/.env.local` to pull from the linked project
- Production env vars (including Upstash Redis + Blob credentials) are managed by Terraform — see `terraform/terraform.tfvars.example`
- See root README.md for full env var documentation

## Envio Gotchas

### Hasura must run on port 8080

The envio binary hardcodes `http://localhost:8080/hasura/healthz?strict=true` for its startup liveness check. This port is not configurable via env vars. **Never set `HASURA_EXTERNAL_PORT` to anything other than 8080** (or omit it entirely) — the binary will silently fail its health check and retry with exponential backoff, stalling startup for 5+ minutes per attempt.

### Only one local indexer at a time

All envio configs share the same Docker project name (`generated`, derived from the `generated/` directory name) and the same Hasura port (8080). Running two local indexers simultaneously will cause container name conflicts. Start one, stop it, then start the other.

### Postgres healthcheck is auto-patched after codegen

The envio-generated `generated/docker-compose.yaml` does not include a healthcheck for the postgres service. Without one, Docker reports `Health:""` and the envio binary waits indefinitely. `scripts/run-envio-with-env.mjs` automatically patches the file to add a `pg_isready` healthcheck after every `pnpm codegen` run. If you regenerate the compose file manually, re-run codegen via the script (not directly via `envio codegen`) to re-apply the patch.

## Common Tasks

### Promoting a new treb deployment

When a new set of contracts has been deployed and a new `@mento-protocol/contracts` version is published:

1. Update the `@mento-protocol/contracts` version in `indexer-envio/package.json` and `ui-dashboard/package.json`
2. Update namespace string(s) in `shared-config/deployment-namespaces.json` (e.g. `"42220": "mainnet-v2"`)
3. Run `pnpm install`
4. Typecheck: `pnpm --filter @mento-protocol/ui-dashboard typecheck` and `pnpm --filter @mento-protocol/indexer-envio typecheck`

### Adding a new contract to index

1. Add ABI to `indexer-envio/abis/`
2. Add contract entry in the relevant config(s): `config.celo.mainnet.yaml`, `config.celo.sepolia.yaml`, `config.monad.mainnet.yaml`, `config.monad.testnet.yaml`
3. Add entity to `schema.graphql`
4. Add handler in `src/EventHandlers.ts`
5. Run `pnpm indexer:codegen` to regenerate types

### Adding a new chart to the dashboard

1. Create component in `ui-dashboard/src/`
2. Add GraphQL query for the data
3. Wire up with SWR for real-time updates

### Adding or changing infrastructure (Vercel project, env vars, Redis)

1. Edit `terraform/main.tf` or `terraform/variables.tf`
2. Run `pnpm infra:plan` to preview
3. Run `pnpm infra:apply` to apply
4. Commit the updated `terraform/main.tf` and `terraform/.terraform.lock.hcl` (state file is gitignored)
