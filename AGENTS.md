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

# Infrastructure (Terraform)
pnpm infra:init               # Init providers (first time or after changes)
pnpm infra:plan               # Preview infrastructure changes
pnpm infra:apply              # Apply infrastructure changes
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
- **Static labels:** `src/lib/networks.ts` maps known contract addresses to names
- **Address book:** `/address-book` page + inline editing; custom labels stored in Upstash Redis, backed up daily to Vercel Blob
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
    │   ├── app/
    │   │   ├── address-book/ # Address book page
    │   │   └── api/address-labels/  # CRUD + export/import/backup routes
    │   ├── components/
    │   │   ├── address-label-editor.tsx   # Inline edit dialog
    │   │   └── address-labels-provider.tsx  # Context: merges static + custom labels
    │   └── lib/
    │       ├── address-labels.ts  # Upstash Redis data access (server-side)
    │       └── networks.ts        # Static contract address→name mappings
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

### Adding or changing infrastructure (Vercel project, env vars, Redis)

1. Edit `terraform/main.tf` or `terraform/variables.tf`
2. Run `pnpm infra:plan` to preview
3. Run `pnpm infra:apply` to apply
4. Commit the updated `terraform/main.tf` and `terraform/.terraform.lock.hcl` (state file is gitignored)
