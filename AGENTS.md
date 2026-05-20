---
title: Monitoring Monorepo Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# AGENTS.md — Monitoring Monorepo

## Overview

pnpm monorepo with three packages:

- `shared-config/` — `@mento-protocol/monitoring-config`: chain + token metadata (chain ID → treb namespace, chain slug/label, explorer URLs, token-symbol derivation)
- `indexer-envio/` — Envio HyperIndex indexer for Celo v3 FPMM pools
- `ui-dashboard/` — Next.js 16 + Plotly.js monitoring dashboard
- `metrics-bridge/` — Hasura → Prometheus gauge exporter for v3 alert rules
- `aegis/` — NestJS App Engine service for v2 alerts plus Grafana Agent, dashboards, and alert-rule Terraform

## Operating Rule (read this before opening PRs)

Context authority, placement, and metadata rules live in
`docs/context-standards.md`. Treat canonical context as current operating truth
and non-canonical notes/plans as historical input that must be verified before
use.

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

## Agent Quality Gate

Before opening or updating an agent-authored PR, run:

```bash
pnpm agent:quality-gate
```

The gate defaults to dry-run mode and maps changed paths to the package checks
and PR checklists that apply. Review the checklist output, then run the mapped
safe local commands with:

```bash
pnpm agent:quality-gate --run
```

The execution mode is intentionally local-only: lint, typecheck, tests, codegen,
Trunk, and formatting/validation commands. It never runs deploy commands or
Terraform apply. If any package manifest, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `.npmrc`, or pnpmfile changed, `--run` refuses to
execute until you review package scripts/lifecycle hooks and pass
`--allow-package-script-changes`. The narrow exception is a root `package.json`
edit limited to `scripts.agent:quality-gate` or
`scripts.agent:quality-gate:test`; the gate treats that as tooling-only and runs
an entrypoint validator plus the gate regression tests instead of the
package-script refusal path. Docs-only changes run targeted Trunk checks against
the changed docs paths instead of full-repo Trunk.

The Trunk pre-push hook delegates to this same path-aware gate with
`--fail-fast --skip-if-fresh`, so the hook stops on the first failed mapped
command instead of burning through the rest of the suite, and it reuses a
recent successful manual gate run when the fetched base commit, mapped command
plan, gate implementation, changed paths, and validated file content are
unchanged. For a push that intentionally changes package scripts or
package-manager config, review the script/lifecycle diff first, then
temporarily set `agent.qualityGate.allowPackageScriptChanges=true` in local git
config for that push.

## PR feedback sweep rule

Before declaring a PR clean, inspect every GitHub feedback surface: top-level PR/issue comments, review submissions and bodies, inline review threads/comments, check-run annotations, and failing check logs. Bot reviews can post actionable multi-finding reports as top-level comments, not only inline comments. A clean or resolved inline-thread list is necessary but not sufficient.

## Review-loop discipline

Treat code review as a batch-boundary verifier, not as the inner edit loop. When a reviewer finds one instance of a hazard, audit the sibling surfaces before pushing: adjacent commands, package-manager files, workflow paths, deploy scripts, shared helpers, parallel components, docs, and tests that encode the same rule.

For process or policy-router PRs, build a coverage matrix before implementation. Use `AGENTS.md`, `docs/pr-checklists/*`, CI path filters, package scripts, and existing command docs to map each changed-path class to its required commands, checklist prompts, refusal guards, and regression tests. Run cheap targeted checks while editing; reserve broad local reviews and external bot reviews for completed batches.

## Recurring PR-review patterns

Recurring automated-review hazards are canonicalized in
`docs/pr-checklists/recurring-review-patterns.md`. Read that checklist when a
change touches cross-layer state, CI/deploy behavior, code-health rules,
dashboard interaction flows, security headers, package-manager behavior, or
other review-prone surfaces. Keep root instructions as routing context; put the
detailed rules in the checklist.

## Quick Commands

```bash
# Install all deps (gated: pnpm refuses registry versions <3 days old via
# minimumReleaseAge in pnpm-workspace.yaml; @mento-protocol/* is exempted.
# Frozen-lockfile installs are unaffected.)
pnpm install

# Indexer
pnpm indexer:codegen              # Generate types from schema (multichain mainnet)
pnpm indexer:dev                   # Start indexer (multichain mainnet: Celo + Monad)
pnpm indexer:mutation              # Targeted StrykerJS baseline for indexer pure logic
pnpm deploy:indexer                # Push HEAD to envio branch and trigger hosted reindex
pnpm deploy:indexer:status <commit> --watch  # Wait for registration, then watch sync
pnpm deploy:indexer:logs <commit> --level error,warn --since 2h  # Runtime issues
pnpm deploy:indexer:metrics <commit>  # Per-chain hosted indexing progress
pnpm deploy:indexer:info <commit>     # Hosted deployment info/cache state
pnpm deploy:indexer:promote <commit>  # Promote a synced deployment to prod

# Code health (CodeScene-equivalent OSS checks)
pnpm code-health:knip              # Strict knip across all packages (blocking)
pnpm code-health:knip:report       # Advisory knip (warn-only) — does not exit non-zero
pnpm code-health:deps              # dependency-cruiser: cross-package boundaries + cycles (blocking)
pnpm code-health:deps:graph        # Render the dependency graph to reports/dep-graph.svg (needs graphviz `dot`)
pnpm code-health:history           # CodeScene-style git history report → reports/code-health-history.md
pnpm code-health:duplication       # jscpd duplication report → reports/jscpd/ (advisory, never blocks)
pnpm code-health:schema-diff       # GraphQL schema breaking-change diff vs origin/main (advisory, never blocks)
pnpm code-health                   # Run knip + deps together (everything except history + duplication)
pnpm lockfile:lint                 # Lockfile integrity + registry check (blocking; no install needed)
pnpm indexer:testnet:codegen       # Generate types (multichain testnet: Celo Sepolia + Monad testnet)
pnpm indexer:testnet:dev           # Start indexer (multichain testnet)

# Dashboard
pnpm dashboard:dev            # Dev server
pnpm dashboard:build          # Production build
pnpm dashboard:size-limit     # Check bundle size against budgets (run after build)
pnpm --filter @mento-protocol/ui-dashboard test:browser                   # Fixture-driven browser interaction + visual snapshot tests
pnpm --filter @mento-protocol/ui-dashboard test:browser:update-snapshots # Re-baseline visual snapshots after a legitimate UI change
pnpm dashboard:mutation       # Targeted StrykerJS baseline for dashboard pure logic
pnpm bridge:mutation          # Targeted StrykerJS baseline for metrics-bridge rebalance probe logic

# Aegis
pnpm aegis:dev                # Start the NestJS App Engine service locally
pnpm aegis:build              # Build the Aegis service
pnpm aegis:typecheck          # Typecheck the Aegis service
pnpm aegis:test               # Jest tests
pnpm aegis:lint               # ESLint baseline gate for Aegis
pnpm aegis:deploy             # Build, stage a locked App Engine app, and deploy Aegis to mento-monitoring
pnpm aegis:logs               # Tail Aegis App Engine logs from mento-monitoring
pnpm aegis:agent:seed-secrets # Seed/rotate Grafana Agent Secret Manager versions
pnpm aegis:agent:deploy       # Deploy the Grafana Agent App Engine service
pnpm aegis:tf:init / aegis:tf:plan / aegis:tf:apply

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

### aegis

- **Package:** `@mento-protocol/aegis`
- **Runtime:** NestJS service deployed to GCP App Engine in `mento-monitoring` (`aegis/app.yaml`)
- **Purpose:** Polls v2 on-chain contract state via RPC view calls and exposes Prometheus metrics at `/metrics`
- **Grafana Agent:** `aegis/grafana-agent/` remains the App Engine service that scrapes Aegis and metrics-bridge, then remote-writes to Grafana Cloud. Terraform creates the Secret Manager containers; run `pnpm aegis:agent:seed-secrets` before the first agent deploy in a fresh project.
- **Terraform:** `aegis/terraform/` owns the Aegis Grafana dashboards, folders, alert rules, Discord contact points, and Splunk On-Call routing. The backend remains `gs://mento-terraform-tfstate-6ed6/aegis`.
- **Contracts:** `aegis/contracts/` uses Foundry with submodules under `aegis/lib/`; run `forge test` from `aegis/` when Solidity helpers change.
- **Commands:** Use the root `pnpm aegis:*` scripts for build/dev/test/lint/deploy/logs/Terraform/Grafana Agent deploy.

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

- **Runtime:** Envio HyperIndex (envio@3.0.0)
- **Schema:** `schema.graphql` defines indexed entities (FPMM, Swap, Mint, Burn, etc.)
- **Configs:** `config.multichain.mainnet.yaml` (default), `config.multichain.testnet.yaml`. `config.yaml` is a symlink to the mainnet config so `createTestIndexer()` resolves a default config when tests run without `--config`.
- **Handlers:** `src/EventHandlers.ts` is the Envio entry point (all `config.*.yaml` files reference it). It imports handler modules from `src/handlers/` and re-exports test utilities. Handler logic lives in `src/handlers/fpmm.ts`, `src/handlers/sortedOracles.ts`, `src/handlers/virtualPool.ts`, `src/handlers/feeToken.ts`. Shared logic: `src/rpc.ts` (barrel re-exports + Oracle DB helpers; RPC primitives split into `src/rpc/` sub-modules), `src/pool.ts` (upsert), `src/priceDifference.ts`, `src/tradingLimits.ts`, `src/feeToken.ts`, `src/abis.ts`, `src/helpers.ts`.
- **Contract addresses:** `src/contractAddresses.ts` — resolves addresses from `@mento-protocol/contracts` using the namespace map from `shared-config`
- **ABIs:** `abis/` — vendored ABIs, refreshed from `@mento-protocol/contracts` via `pnpm --filter @mento-protocol/indexer-envio generate:abis`. ERC20 stub + Wormhole NTT minimal subsets are hand-vendored (excluded from the script — see `indexer-envio/scripts/generateAbis.mjs` header).
- **Codegen output:** `.envio/types.d.ts` (gitignored) is generated by `pnpm codegen`; the tracked `envio-env.d.ts` triple-slash references it into the `envio` module. A fresh clone needs `pnpm codegen` (or `./scripts/setup.sh`) before `pnpm typecheck` will succeed.
- **Scripts:** `scripts/run-envio-with-env.mjs` — loads .env and runs envio CLI
- **Performance diagnostics:** `INDEXER_PERF=1 INDEXER_PERF_LOG_INTERVAL_EVENTS=10000 pnpm indexer:dev` logs opt-in handler/effect/entity counters; `node indexer-envio/scripts/auditSchemaIndexes.mjs` audits schema indexes against local handler `getWhere`, dashboard/bridge GraphQL usage, and known dynamic discovery queries before any pruning.
- **Tests:** `test/` — vitest. MockDb-facade integration tests run through `test/helpers/indexerTestHarness.ts`, which adapts MockDb-style entity assertions onto Envio v3's `createTestIndexer()` and the local HTTP RPC mock layer.
- **Docker:** Envio dev mode spins up Postgres + Hasura automatically

### ui-dashboard

- **Framework:** Next.js 16 (App Router, React 19)
- **Charts:** Plotly.js via react-plotly.js
- **Data:** GraphQL queries to Hasura (via graphql-request + SWR)
- **Styling:** Tailwind CSS 4
- **Multi-chain:** Network selector switches between celo-mainnet, celo-sepolia, monad-mainnet, monad-testnet Hasura endpoints; all networks defined in `src/lib/networks.ts`
- **Contract labels:** token symbols and address labels come from `@mento-protocol/monitoring-config/tokens` (shared with metrics-bridge); `src/lib/networks.ts` layers per-network `addressLabels` overrides on top. Explorer base URLs default from `@mento-protocol/monitoring-config/chains`; each network keeps its env-var override (`NEXT_PUBLIC_EXPLORER_URL_*`) for local dev
- **Address book:** `/address-book` page + inline editing; custom labels stored in Upstash Redis under a single `labels` hash keyed by lowercase address (no chain/global scope — same EVM address means same entity, so a single label applies wherever the address appears). Backed up daily to Vercel Blob alongside forensic reports (same blob, `addresses` + `reports` keys); custom labels override/extend the package-derived ones. Large restores use `POST /api/address-labels/restore?pathname=<blob-pathname>` (cron-secret or session) so the server pulls the private Blob snapshot directly and preserves forensic-report author/timestamp/version metadata from first-party backups. User-uploaded imports through `/api/address-labels/import` still re-stamp report metadata to the importing session.
- **Forensic reports:** long-form markdown investigations attached to an address (separate from the 500-char `notes` field). Stored in Upstash under a single `reports` hash keyed by lowercase address. Reports are address-keyed only — no chain/global scope. Same EVM address means same entity (same private key derives the same address across every chain), so a single report applies wherever the address appears. Backed up daily inside the same Vercel Blob snapshot as labels (`reports` key in the snapshot JSON; restorable via `/api/address-labels/import`). Never write deep investigations into `notes` — use the address detail page's report editor or the `/forensic-report` skill. Body cap is 50KB; auth-gated, never public. Drafts live in the gitignored `.investigations/` folder at the repo root; the skill produces them and can push the finished draft directly to Upstash so the prose never round-trips through copy-paste
- **Deployment:** Vercel (`monitoring-dashboard` project); infra managed by Terraform in `terraform/`
- **Browser tests:** `pnpm --filter @mento-protocol/ui-dashboard test:browser` runs Playwright against the real Next.js app with a local GraphQL fixture server (`ui-dashboard/tests/browser/fixtures/hasura-fixture-server.mjs`). These tests must stay fixture-driven and must not hit hosted Hasura/Envio.
  - **Visual snapshots:** 5 pages snapshotted (pools list, pool detail LPs, pool detail Swaps, bridge flows, leaderboard). Baselines live in `ui-dashboard/tests/browser/visual-snapshots.test.ts-snapshots/` and are committed. Re-baseline after a legitimate UI change: `pnpm --filter @mento-protocol/ui-dashboard test:browser:update-snapshots`. PRs touching styled components must verify baselines pass. Threshold: `maxDiffPixelRatio: 0.03` (3% ratio; accommodates macOS/Linux font anti-aliasing differences); relative timestamps are masked so they do not cause false-positive failures. To regenerate Linux-native baselines on CI: trigger `.github/workflows/update-snapshots.yml` via workflow_dispatch on the branch.

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
│   │   ├── rpc.ts            # Barrel re-exports + Oracle DB query helpers (barrel for rpc/* primitives)
│   │   ├── rpc/              # RPC sub-modules (extracted from rpc.ts in PR-S6 through PR-S9)
│   │   │   ├── client.ts     # RPC client management, failure logging, rate-limit detection
│   │   │   ├── block-fallback.ts  # readContractWithBlockFallback retry/fallback primitive
│   │   │   ├── pool-state.ts # Pool/oracle RPC fetchers, caches, and test mocks
│   │   │   └── breakers.ts   # Breaker RPC self-heal: fetchBreakerKind/Defaults/FeedState + probe
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
    │   │   ├── api/address-labels/   # Labels CRUD + export/import/backup routes
    │   │   └── api/address-reports/  # Forensic-report CRUD (auth-gated, 50KB markdown bodies)
    │   ├── components/
    │   │   ├── address-label-editor.tsx     # Modal with Label/Tags + Forensic Report tabs
    │   │   ├── address-labels-provider.tsx  # Context: merges package + custom labels
    │   │   ├── address-report-editor.tsx    # Markdown editor + preview for the report tab
    │   │   └── markdown-renderer.tsx        # react-markdown wrapper used by the report editor
    │   ├── hooks/
    │   │   └── use-address-reports-index.ts # SWR hook for the lightweight report-presence index (powers the 📄 indicator)
    │   └── lib/
    │       ├── address-labels.ts             # Upstash Redis data access (server-side)
    │       ├── address-labels/import.ts      # Import handlers (CSV/JSON/Snapshot/Gnosis Safe) for /api/address-labels/import
    │       ├── address-reports.ts            # Upstash Redis data access for forensic reports
    │       ├── address-reports-shared.ts     # Isomorphic types + sanitization for reports (50KB body cap)
    │       └── networks.ts                   # Network defs; delegates token/label derivation to @mento-protocol/monitoring-config
    ├── public/               # Static assets
    ├── vercel.json           # Vercel config + daily backup cron
    └── next.config.ts        # Next.js config
```

Standalone investigation drafts live under the gitignored `.investigations/<address>-<slug>.md` (a directory at the repo root, NOT in `docs/`). Drafts stay local — they routinely identify individuals + on-chain identities, so committing them to a public history would be its own finding. The `/forensic-report` skill produces them in the canonical structure and, on confirmation, writes the finished draft straight to the `reports` hash in Upstash via the management MCP (no copy-paste through the report editor).

## Environment

- Indexer needs Docker for local dev (Postgres + Hasura containers)
- Dashboard needs `NEXT_PUBLIC_HASURA_URL` env var for local dev; run `vercel env pull ui-dashboard/.env.local` to pull from the linked project
- Production env vars (including Upstash Redis + Blob credentials) are managed by Terraform — see `terraform/terraform.tfvars.example`
- See root README.md for full env var documentation

## Claude Code Slash Commands

Repo-tracked under `.claude/commands/`. Each `.md` file is the body Claude Code loads when you type `/<filename>`. Add a new one by dropping a markdown file in that directory; remove one by deleting the file.

| Command                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/verify-ui`                         | Drive chrome-devtools MCP through the dashboard's pages with token-budget guidance and per-page acceptance checks (KPI presence, chart wiring, interaction smoke tests, responsive layouts). Defaults to `localhost:3000`; pass `prod` to verify against `monitoring.mento.org`.                                                                                                                                                                                                                                                                          |
| `/babysit-indexer-deploy [<commit>]` | Arm a `Monitor` that polls Envio's deployment registry every 45s internally but only emits on state change (`REGISTERED` / `READY_TO_PROMOTE` / `BUILD_FAILED` / `SYNC_DEADLINE` / `ERROR`). Prompts for `pnpm deploy:indexer:promote <commit>` once every chain is caught up — never auto-promotes. Bails after 30min of 404s (build likely failed) or 90min of stagnation. Defaults to `git rev-parse --short origin/envio` when no commit is passed. Replaces the prior `/loop 5m` cron version, which produced ~12 idle macOS notifications per sync. |

To use them you need [Claude Code](https://claude.com/claude-code). Personal/local-only commands belong in your own `~/.claude/commands/` (or in `.git/info/exclude` if you want to keep them in this directory but not share).

## Codex Agent Skills

Repo-tracked Codex skills live under `.agents/skills/`. Keep durable,
team-shareable agent workflows there instead of relying on local-only
`~/.codex` or `~/.claude` state. Project-level Codex MCP config lives in
`.codex/config.toml`; local personal Codex settings still belong in
`~/.codex/config.toml`.

### Status-polling commands use `Monitor`, not `/loop`

For commands that watch a long-running external process (Envio sync, PR CI, deploy progress, etc.), prefer the `Monitor` tool over `/loop` + cron. Monitor runs a single shell script that polls internally at 30–60s and only emits stdout lines (== notifications) on state changes worth surfacing. Cron / `/loop` fires a full Stop turn per interval, which triggers a macOS notification regardless of whether anything changed — a 60-min sync produces ~12 idle notifications, vs 2–3 with Monitor. `babysit-indexer-deploy` and `babysit-pr` are the canonical examples; if you find yourself writing a new "watch X every Y minutes" command, model it on those.

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

> ⚠️ **Do not assume git hooks are installed.** `./scripts/setup.sh` points
> `core.hooksPath` at `.trunk/hooks`, but fresh worktrees, server clones, and
> unusual git setups can miss that configuration. When hooks are absent or
> uncertain, CI becomes the first place checks run — and CI failures are far
> more expensive than local checks. Always run these manually before pushing:

```bash
git fetch origin main
./tools/trunk fmt --all
./tools/trunk check --all
pnpm dashboard:react-doctor:diff
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
4. Refresh vendored ABIs from the new package: `pnpm --filter @mento-protocol/indexer-envio generate:abis`. Commit any resulting diff under `indexer-envio/abis/`.
5. Typecheck: `pnpm --filter @mento-protocol/ui-dashboard typecheck` and `pnpm --filter @mento-protocol/indexer-envio typecheck`

### Adding a new contract to index

1. Add the ABI to `indexer-envio/abis/`:
   - **If it ships in `@mento-protocol/contracts`:** add the filename to the allow-list in `indexer-envio/scripts/generateAbis.mjs` and run `pnpm --filter @mento-protocol/indexer-envio generate:abis`.
   - **Otherwise** (e.g. external/minimal-subset ABIs like the Wormhole NTT trio): hand-vendor under `indexer-envio/abis/` and document the exclusion in the `generateAbis.mjs` header so future runs don't try to overwrite it.
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
