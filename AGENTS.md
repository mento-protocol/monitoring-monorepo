# AGENTS.md — Monitoring Monorepo

## Overview

pnpm monorepo with three packages:

- `shared-config/` — `@mento-protocol/monitoring-config`: chain + token metadata (chain ID → treb namespace, chain slug/label, explorer URLs, token-symbol derivation)
- `indexer-envio/` — Envio HyperIndex indexer for Celo v3 FPMM pools
- `ui-dashboard/` — Next.js 16 + Plotly.js monitoring dashboard
- `metrics-bridge/` — Hasura → Prometheus gauge exporter for v3 alert rules

## Operating Rule (read this before opening PRs)

> **Any PR that adds or changes stateful data flow across layers must ship with explicit invariants, degraded-mode behavior, and interaction tests before opening.**

This repo has already paid the tax for learning this the hard way.

If your change touches any combination of:

- Envio schema/entities
- event handlers / entity writers
- generated types / GraphQL queries / dashboard types
- paginated or sortable UI state
- partial failure behavior (missing counts, stale RPC, missing txHash, etc.)

then you are expected to run the dedicated PR checklist before opening or updating the PR:

- **Checklist:** `docs/pr-checklists/stateful-data-ui.md`

Do not rely on PR review to finish the design. Reviews should catch misses, not define the invariants for the first time.

## Recurring PR-review patterns — fix locally, not in review

Across the last 20 PRs, automated reviewers (`cursor[bot]`, `chatgpt-codex-connector[bot]`) raised ~100 findings clustered into the categories below. Each rule is a hard must/never — if your change touches one of these areas, follow the linked checklist before opening the PR.

### SWR + Hasura polling — `docs/pr-checklists/swr-polling-hasura.md`

- Every SWR hook polling Hasura MUST set `revalidateOnFocus: false` AND `revalidateOnReconnect: false`. Fix the default at `useGQL` (`ui-dashboard/src/lib/graphql.ts`), not at every call site
- Pair `AbortSignal.timeout(8_000)` with the 10s refresh interval so a wedged TCP connection can't backpressure the polling loop
- Distinguish `isLoading` from "data resolved to zero" — never render "100% / no breaches" while `data === undefined`
- Hasura silently caps queries at 1000 rows; any custom `limit:` in a UI query that feeds a lifetime-aggregate metric is a bug — use a pre-rolled snapshot/rollup entity, or model your fetch after the offset-pagination pattern in `ui-dashboard/src/hooks/use-all-networks-data.ts` (`fetchPaginatedSnapshotPages`)

### Time-unit math — `docs/pr-checklists/stateful-data-ui.md`

- FX-pool metrics use trading-seconds (FX weekend subtracted). Live "open breach" math MUST use the same unit as stored values — call `tradingSecondsInRange` (`ui-dashboard/src/lib/weekend.ts:110`), never `now - start` directly
- Threshold-derived metrics (peak severity %, etc.) MUST be computed from the per-event threshold, not from the live mutable `pool.rebalanceThreshold`

### Indexer entity IDs

- Composite IDs MUST include enough entropy to be collision-resistant under same-block writes. `poolId + startedAt(seconds)` is **insufficient** — include `chainId`, `blockNumber`, and `logIndex` (or `txHash + logIndex`)
- Cumulative counters belong on the entity (rolled up in handlers), not derived client-side from a paginated list

### Grafana alerts / PromQL — `docs/pr-checklists/grafana-alerts.md`

- PromQL filters on the `pair` label MUST include `pair=~".+/.+"` structural guard — `metrics-bridge` falls back `pair = pool.id` for unmapped token symbols, which would otherwise slip through negated-regex filters and silently silence alerts (bit us on PR #221 FX weekend gate)
- USD-pegged symbol set must stay in sync between `terraform/alerts/main.tf` (`usd_pegged_symbols_regex_part`) and `ui-dashboard/src/lib/tokens.ts` (`USD_PEGGED_SYMBOLS`); both sides carry cross-reference comments pointing at each other
- Pool-scoped rules (have `chain_id`/`pool_id` labels) use `local.notify_*_pool` (drops `alertname` so co-firing KPI rules on the same pool collapse into one Slack thread); service-scoped rules (metrics-bridge) MUST use `local.notify_*` (keeps `alertname`) or they merge into one folder-level group
- Slack title template MUST handle empty `{{ .CommonLabels.alertname }}` via `{{ if .CommonLabels.alertname }}...{{ else }}{{ len .Alerts }} alerts{{ end }}` for groups spanning distinct alertnames
- Before gating a critical rule on a time window (FX weekend etc.), verify the "backup" rule transitions cleanly under real degraded conditions — `Pool.oracleOk` never flips to false today (tracked in `docs/BACKLOG.md`), so `Oracle Down` is NOT the safety net it looks like

### Terraform + Cloud Run — `docs/pr-checklists/terraform-cloudrun.md`

- Removing `count` / renaming a resource requires a `moved` block; `deletion_protection = true` makes a missed `moved` block fatal to the apply
- Cloud Run `--revision-suffix` MUST start with a lowercase letter (RFC 1035, ~62% of raw hex SHAs fail) AND MUST be unique per run (append `$GITHUB_RUN_ID` or epoch)
- Probe paths use `/health`, never `/healthz` (Cloud Run v2 reserves `/healthz` at the frontend)
- Bootstrap/default `image` MUST respond to the configured probe path; `gcr.io/cloudrun/hello:latest` does NOT serve `/health`
- Deployer SAs need `roles/iam.serviceAccountTokenCreator` on the runtime SA they impersonate (WIF requirement)

### CI workflow gates — `docs/pr-checklists/ci-workflow-gates.md`

- Required-status workflows MUST NOT use `paths:` / `paths-ignore:` filters — skipped runs leave the check pending forever and silently block unrelated merges
- Every deploy job MUST gate on `if: github.ref == 'refs/heads/main'`; `push.branches` alone doesn't constrain `workflow_dispatch`
- Third-party actions in deploy paths MUST be SHA-pinned (`uses: org/action@<40-char-sha> # vX.Y.Z`)
- Deploy workflows MUST set a workflow-name concurrency group with `cancel-in-progress: false`
- Cache keys MUST include every input that affects the cached output (codegen scripts, configs, schema)

### Security / CSP

- CSP `connect-src` must include every Hasura + RPC endpoint the dashboard calls (source of truth: `ui-dashboard/next.config.ts`'s `CSP_CONNECT_SRC`)
- Do NOT widen `script-src` with `unsafe-eval` without proof a library actually needs it — the current policy is deliberately tight and Plotly runs fine without it
- Auth/allowlist constants must be centralized — don't repeat domain literals across files

### Migration discipline

- Don't remove an env-var fallback in the same PR that introduces the new var. Keep dual-read for one release so mid-deploy state doesn't break

## Quick Commands

```bash
# Install all deps
pnpm install

# Indexer
pnpm indexer:codegen              # Generate types from schema (multichain mainnet)
pnpm indexer:dev                   # Start indexer (multichain mainnet: Celo + Monad)
pnpm indexer:testnet:codegen       # Generate types (multichain testnet: Celo Sepolia + Monad testnet)
pnpm indexer:testnet:dev           # Start indexer (multichain testnet)

# Dashboard
pnpm dashboard:dev            # Dev server
pnpm dashboard:build          # Production build

# Infrastructure (Terraform)
pnpm infra:init               # Init providers (first time or after changes)
pnpm infra:plan               # Preview infrastructure changes
pnpm infra:apply              # Apply infrastructure changes
# Same shape for Grafana alert rules:
pnpm alerts:init / alerts:plan / alerts:apply
```

**Terraform from a worktree** (e.g. `.claude/worktrees/<name>/`): `pnpm infra:*` scripts don't pass `-var-file`, and `terraform.tfvars` only lives in the main checkout (gitignored). Either run the commands from the main checkout, or from inside the worktree's `terraform/`:

```bash
terraform init -reconfigure   # GCS backend needs reinit in a fresh worktree
terraform plan  -var-file=/Users/chapati/code/mento/monitoring-monorepo/terraform/terraform.tfvars
```

Never `terraform apply` without explicit user approval — plan first, surface the diff, wait for go-ahead.

## Package Details

### shared-config

- **Package:** `@mento-protocol/monitoring-config` (private, built with `pnpm --filter @mento-protocol/monitoring-config build`)
- **Purpose:** Single source of truth for chain + token metadata across the monorepo. Derives token symbols, pool pair labels, and explorer URLs from `@mento-protocol/contracts` + `shared-config/*.json` so every consumer stays on the same data.
- **Consumed by:** `ui-dashboard` and `metrics-bridge` via `workspace:*` dependency. `indexer-envio` intentionally vendors `config/deployment-namespaces.json` + reimplements its token filter in `src/feeToken.ts` — Envio may build the indexer outside the pnpm workspace, so the workspace dep is unsafe there (see `indexer-envio/src/contractAddresses.ts:14-18`).
- **Exports:**
  - `./deployment-namespaces.json` — chain ID → active treb namespace (edit when promoting a new deployment)
  - `./fx-calendar.json` — FX market close/reopen anchors for weekend-aware oracle math
  - `./chain-metadata.json` — chain ID → `{ slug, label, explorerBaseUrl }` (new — edit when a new chain comes online)
  - `./chains` — `chainSlug`, `chainLabel`, `explorerBaseUrl`, `explorerAddressUrl`, `explorerTxUrl`
  - `./tokens` — `tokenSymbol`, `poolName`, `contractEntries`, `chainTokenSymbols`, `chainAddressLabels`
  - `./format` — `poolIdAddress`, `shortAddress`

**Rule:** Before hardcoding a chain slug, explorer URL, pool pair label, or token symbol, check whether `@mento-protocol/monitoring-config` already exposes it. Duplicating chain/token metadata caused PR #209 (Monad Slack alerts shipped raw `143-0x93e1…` pool ids).

### indexer-envio

- **Runtime:** Envio HyperIndex (envio@2.32.3)
- **Schema:** `schema.graphql` defines indexed entities (FPMM, Swap, Mint, Burn, etc.)
- **Configs:** `config.multichain.mainnet.yaml` (default), `config.multichain.testnet.yaml`
- **Handlers:** `src/EventHandlers.ts` is the Envio entry point (all `config.*.yaml` files reference it). It imports handler modules from `src/handlers/` and re-exports test utilities. Handler logic lives in `src/handlers/fpmm.ts`, `src/handlers/sortedOracles.ts`, `src/handlers/virtualPool.ts`, `src/handlers/feeToken.ts`. Shared logic: `src/rpc.ts` (RPC + caches), `src/pool.ts` (upsert), `src/priceDifference.ts`, `src/tradingLimits.ts`, `src/feeToken.ts`, `src/abis.ts`, `src/helpers.ts`.
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
- **Contract labels:** token symbols and address labels come from `@mento-protocol/monitoring-config/tokens` (shared with metrics-bridge); `src/lib/networks.ts` layers per-network `addressLabels` overrides on top. Explorer base URLs default from `@mento-protocol/monitoring-config/chains`; each network keeps its env-var override (`NEXT_PUBLIC_EXPLORER_URL_*`) for local dev
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
├── shared-config/            # @mento-protocol/monitoring-config (private, built TS)
│   ├── package.json
│   ├── tsconfig.json
│   ├── deployment-namespaces.json  # ← edit when promoting a new deployment
│   ├── chain-metadata.json         # ← edit when a new chain comes online
│   ├── fx-calendar.json            # FX market close/reopen anchors
│   ├── src/                        # chains.ts, tokens.ts, format.ts
│   └── __tests__/                  # vitest suites (includes known-pool regression fixture)
├── indexer-envio/
│   ├── config.multichain.mainnet.yaml  # Mainnet indexer config (Celo + Monad) — DEFAULT
│   ├── config.multichain.testnet.yaml  # Testnet multichain config
│   ├── schema.graphql        # Entity definitions
│   ├── src/
│   │   ├── EventHandlers.ts  # Envio entry point (imports handlers, re-exports for tests)
│   │   ├── handlers/         # Event handler registrations
│   │   │   ├── fpmm.ts       # FPMMFactory + FPMM handlers
│   │   │   ├── sortedOracles.ts  # SortedOracles handlers
│   │   │   ├── virtualPool.ts    # VirtualPool handlers
│   │   │   └── feeToken.ts       # ERC20FeeToken.Transfer handler
│   │   ├── rpc.ts            # RPC client, fetch functions, caches, test mocks
│   │   ├── pool.ts           # Pool/PoolSnapshot upsert, health status
│   │   ├── priceDifference.ts # Price math (computePriceDifference, normalizeTo18)
│   │   ├── tradingLimits.ts  # Trading limit types and computation
│   │   ├── feeToken.ts       # Fee token metadata, backfill, YIELD_SPLIT_ADDRESS
│   │   ├── abis.ts           # ABI definitions
│   │   ├── helpers.ts        # Pure utilities (eventId, asAddress, etc.)
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
    │       └── networks.ts        # Network defs; delegates token/label derivation to @mento-protocol/monitoring-config
    ├── public/               # Static assets
    ├── vercel.json           # Vercel config + daily backup cron
    └── next.config.ts        # Next.js config
```

## Environment

- Indexer needs Docker for local dev (Postgres + Hasura containers)
- Dashboard needs `NEXT_PUBLIC_HASURA_URL` env var for local dev; run `vercel env pull ui-dashboard/.env.local` to pull from the linked project
- Production env vars (including Upstash Redis + Blob credentials) are managed by Terraform — see `terraform/terraform.tfvars.example`
- See root README.md for full env var documentation

## Claude Code Slash Commands

Repo-tracked under `.claude/commands/`. Each `.md` file is the body Claude Code loads when you type `/<filename>`. Add a new one by dropping a markdown file in that directory; remove one by deleting the file.

| Command                              | Purpose                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/verify-ui`                         | Drive chrome-devtools MCP through the dashboard's pages with token-budget guidance and per-page acceptance checks (KPI presence, chart wiring, interaction smoke tests, responsive layouts). Defaults to `localhost:3000`; pass `prod` to verify against `monitoring.mento.org`.                                                    |
| `/babysit-indexer-deploy [<commit>]` | Poll Envio's deployment registry every 5min, surface per-chain sync %, and prompt for `pnpm deploy:indexer:promote <commit>` once every chain is caught up. Never auto-promotes. Bails after 30min of 404s (build likely failed) or 90min of stagnation. Defaults to `git rev-parse --short origin/envio` when no commit is passed. |

To use them you need [Claude Code](https://claude.com/claude-code). Personal/local-only commands belong in your own `~/.claude/commands/` (or in `.git/info/exclude` if you want to keep them in this directory but not share).

## Envio Gotchas

### Hasura must run on port 8080

The envio binary hardcodes `http://localhost:8080/hasura/healthz?strict=true` for its startup liveness check. This port is not configurable via env vars. **Never set `HASURA_EXTERNAL_PORT` to anything other than 8080** (or omit it entirely) — the binary will silently fail its health check and retry with exponential backoff, stalling startup for 5+ minutes per attempt.

### Only one local indexer at a time

All envio configs share the same Docker project name (`generated`, derived from the `generated/` directory name) and the same Hasura port (8080). Running two local indexers simultaneously will cause container name conflicts. Start one, stop it, then start the other.

### Postgres healthcheck is auto-patched after codegen

The envio-generated `generated/docker-compose.yaml` does not include a healthcheck for the postgres service. Without one, Docker reports `Health:""` and the envio binary waits indefinitely. `scripts/run-envio-with-env.mjs` automatically patches the file to add a `pg_isready` healthcheck after every `pnpm codegen` run. If you regenerate the compose file manually, re-run codegen via the script (not directly via `envio codegen`) to re-apply the patch.

## New Worktree / Clone Setup

After creating a new worktree or cloning the repo, run:

```bash
./scripts/setup.sh
```

This installs deps and runs Envio codegen (required for `indexer-envio` TypeScript to compile — the `generated/` dir is gitignored).

## Pre-Push Checklist (MANDATORY for server-side work)

> ⚠️ **Git hooks don't run on the server.** Trunk's pre-push hooks live in the Mac's common `.git/hooks/` dir. When pushing from the server, they are silently skipped. CI is the first place checks run — and CI failures are far more expensive than local checks. Always run these manually before pushing:

```bash
./tools/trunk fmt --all
./tools/trunk check --all
pnpm --filter @mento-protocol/ui-dashboard typecheck
pnpm --filter @mento-protocol/indexer-envio typecheck
pnpm --filter @mento-protocol/indexer-envio test
pnpm indexer:codegen   # Validates Envio can parse handler entry point + module imports
pnpm --filter @mento-protocol/ui-dashboard test:coverage
```

Before pushing any cross-layer or stateful UI change, also read and apply:

- **`docs/pr-checklists/stateful-data-ui.md`**

**Common traps:**

- `codespell` flags short variable names that match common abbreviations (e.g. a two-letter loop var that looks like a misspelling). Use descriptive names like `netData` to avoid this.
- `trunk check <file>` only checks the specified files — always use `--all` to match what CI runs
- If `indexer-envio typecheck` fails with "Cannot find module 'generated'", run `./scripts/setup.sh` first

### EventHandlers.ts must remain the handler entry point

Every `config.*.yaml` specifies `handler: src/EventHandlers.ts`. Envio expects all handler registrations (e.g. `FPMM.Swap.handler(...)`) to be reachable from this file at module load time. The actual logic lives in `src/handlers/*.ts` — these are imported as side effects from `EventHandlers.ts`. If you add a new handler file, you **must** add a corresponding `import "./handlers/yourFile"` in `EventHandlers.ts` and then re-run `pnpm indexer:codegen` to verify Envio picks it up.

## Common Tasks

### Promoting a new treb deployment

When a new set of contracts has been deployed and a new `@mento-protocol/contracts` version is published:

1. Update the `@mento-protocol/contracts` version in `indexer-envio/package.json` and `ui-dashboard/package.json`
2. Update namespace string(s) in `shared-config/deployment-namespaces.json` (e.g. `"42220": "mainnet-v2"`)
3. Run `pnpm install`
4. Typecheck: `pnpm --filter @mento-protocol/ui-dashboard typecheck` and `pnpm --filter @mento-protocol/indexer-envio typecheck`

### Adding a new contract to index

1. Add ABI to `indexer-envio/abis/`
2. Add contract entry in the relevant config(s): `config.multichain.mainnet.yaml`, `config.multichain.testnet.yaml`
3. Add entity to `schema.graphql`
4. Add handler in the appropriate `src/handlers/*.ts` file (or create a new one and import it from `src/EventHandlers.ts`)
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
