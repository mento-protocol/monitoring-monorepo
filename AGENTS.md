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
edit limited to root tooling scripts such as `scripts.agent:quality-gate`,
`scripts.agent:quality-gate:test`, `scripts.agent:prewarm`,
`scripts.agent:prewarm:test`, `scripts.agent:context-check`,
`scripts.pr:ready-state`, `scripts.pr:ready-state:test`,
`scripts.lockfile:lint`, or `scripts.lockfile:lint:test`; the gate treats that
as tooling-only and runs an entrypoint validator plus the gate/prewarm/PR-ready
regression tests instead of the package-script refusal path. Existing changed
paths run targeted Trunk checks for faster local iteration. Deleted paths,
Trunk/tooling changes, and package-manager or package-manifest changes still run
full-repo Trunk locally. CI also runs a required full-repo Trunk check on every
PR.

To warm Turbo's local cache for the Turbo-backed package tasks mapped by the
same gate without running deploy, Terraform, mutation, codegen, or install
commands, use:

```bash
pnpm agent:prewarm --base origin/main
```

It is a no-op when the gate maps no relevant Turbo commands. Like the run mode
gate, prewarm refuses to execute Turbo-backed package scripts when package
manifests, lockfiles, `.npmrc`, or pnpmfile changed unless you first review the
script/lifecycle diff and pass `--allow-package-script-changes`.

The Trunk pre-push hook delegates to this same path-aware gate with
`--fail-fast --skip-if-fresh`, so the hook stops on the first failed mapped
command instead of burning through the rest of the suite, and it reuses a
recent successful manual gate run when the fetched base commit, mapped command
plan, gate implementation, changed paths, and validated file content are
unchanged. For a push that intentionally changes package scripts or
package-manager config, review the script/lifecycle diff first, then
temporarily set `agent.qualityGate.allowPackageScriptChanges=true` in local git
config for that push.

Package-local gate tasks for `lint`, `typecheck`, `test`, `knip`, dashboard
build, dashboard size-limit, local dashboard browser tests, and dashboard React
Doctor checks run through Turbo's local filesystem cache
(`pnpm exec turbo run ... --cache=local:rw`). Remote caching is disabled in
`turbo.json`. The Turbo config is only for the gate's explicit per-package
`--filter` invocations; do not use it as a general workspace task orchestrator.
Dashboard build/browser/React Doctor cache keys explicitly include
`shared-config`, package-manager, workflow, wrapper-script, and relevant env
inputs; CI still runs browser tests normally and remains the Linux snapshot
authority. The only task dependency is `size-limit -> build`, because
size-limit reads `.next/` output. High-risk or cross-layer commands stay
outside Turbo, including codegen, install, dep-cruiser, mutation baselines, and
Terraform.

## PR feedback sweep rule

Before declaring a PR clean, inspect every GitHub feedback surface: top-level PR/issue comments, review submissions and bodies, inline review threads/comments, check-run annotations, and failing check logs. Bot reviews can post actionable multi-finding reports as top-level comments, not only inline comments. A clean or resolved inline-thread list is necessary but not sufficient.

Hard stop: a PR is not all clear until `chatgpt-codex-connector[bot]` has left a 👍 reaction on the PR description for the current head. A Codex review comment on an older commit, elapsed grace time, green checks, or another actor's reaction does not satisfy this gate.

Before signaling all-clear, both Claude Code and Codex babysitting flows must
run the shared readiness probe:

```bash
pnpm pr:ready-state --pr <number> --json
```

For an interactive low-noise watch, use:

```bash
pnpm pr:ready-state --pr <number> --watch --compact
```

Use the command's required-only result as the readiness source of truth. The raw
GitHub status rollup and required review gates decide readiness; advisory bot
lag is reported separately. In particular, Cursor Bugbot can trail the current
status rollup, so do not block all-clear on Cursor unless its check or review is
required by branch protection for that PR. See `docs/notes/pr-ready-state.md`
for the expected CLI fields and Claude/Codex workflow contract.

Codex re-reviews new pushes automatically. Do not post `@codex review` as a
routine post-push step, and never post duplicate review requests while a
current-head Codex request is `requested`, `in_flight`, or `approved` in
`pr:ready-state`. Use one manual request only as a fallback when the current
head has no Codex signal after the normal automatic-review window.

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
# Event-driven alerts stack (Cloud Function + Discord channels + Sentry bridge + QuickNode webhooks):
pnpm alerts:infra:init / alerts:infra:plan / alerts:infra:apply
# Grafana metric alert rules (v3 Slack rules):
pnpm alerts:rules:init / alerts:rules:plan / alerts:rules:apply
```

**Terraform from a worktree** (e.g. `.claude/worktrees/<name>/`): `pnpm infra:*` scripts don't pass `-var-file`, and `terraform.tfvars` only lives in the main checkout (gitignored). Either run the commands from the main checkout, or from inside the worktree's `terraform/`:

```bash
terraform init -reconfigure   # GCS backend needs reinit in a fresh worktree
terraform plan  -var-file=<main-checkout>/terraform/terraform.tfvars
```

Never `terraform apply` without explicit user approval — plan first, surface the diff, wait for go-ahead.

## Package routing index

Each package has its own `AGENTS.md` (Claude Code reads them as `CLAUDE.md` via symlink). Open the relevant file for package-specific rules, gotchas, and verification.

| Package           | What it does                                                                                                                                                                                                                                                              | Read                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `aegis/`          | NestJS App Engine service polling v2 view calls → Prometheus `/metrics`; also owns Aegis Grafana dashboards/alerts (`aegis/terraform/`)                                                                                                                                   | [`aegis/AGENTS.md`](aegis/AGENTS.md)                   |
| `shared-config/`  | `@mento-protocol/monitoring-config`: chain/token metadata, FX calendar, deployment namespaces. Source of truth — never duplicate chain slugs, explorer URLs, or token labels elsewhere (PR #209). Indexer vendors a copy because Envio builds outside the pnpm workspace. | [`shared-config/AGENTS.md`](shared-config/AGENTS.md)   |
| `indexer-envio/`  | Envio HyperIndex (envio@3.0.0): Celo + Monad FPMM + v2 Broker. Schema in `schema.graphql`. Handler entry point is `src/EventHandlers.ts` (imports under `src/handlers/`).                                                                                                 | [`indexer-envio/AGENTS.md`](indexer-envio/AGENTS.md)   |
| `ui-dashboard/`   | Next.js 16 + Plotly.js + SWR + Tailwind 4. Address book + forensic reports stored in Upstash (`labels` + `reports` hashes), backed up daily to Vercel Blob.                                                                                                               | [`ui-dashboard/AGENTS.md`](ui-dashboard/AGENTS.md)     |
| `metrics-bridge/` | Hasura → Prometheus gauge exporter for v3 alert rules; bounded label cardinality required.                                                                                                                                                                                | [`metrics-bridge/AGENTS.md`](metrics-bridge/AGENTS.md) |
| `terraform/`      | Vercel project + Upstash Redis + env vars + Cloud Run services. `pnpm infra:plan` before any apply; never apply without human approval.                                                                                                                                   | [`terraform/AGENTS.md`](terraform/AGENTS.md)           |
| `alerts/`         | All alert plumbing. `alerts/rules/` = v3 Grafana metric alert rules (Slack-only); `alerts/infra/` = event-driven delivery (QuickNode→Cloud Fn→Discord + Sentry→Discord bridge + Discord channel/webhook mgmt). `alerts/infra/onchain-event-handler/` is the TS pnpm pkg.  | [`alerts/infra/README.md`](alerts/infra/README.md)     |
| `scripts/`        | Deploy wrappers, agent quality gate, code-health checks. `set -euo pipefail`; refuse dirty trees before mutating external systems.                                                                                                                                        | [`scripts/AGENTS.md`](scripts/AGENTS.md)               |

### PR Review Guidance (Dashboard Scale)

- Current expected scale is roughly **30–50 total pools**.
- At this size, client-side aggregation for the 24h volume tiles/table is acceptable with the current polling setup.
- Do **not** flag the current snapshot-query aggregation path as a scalability issue in PR reviews unless assumptions change materially (e.g. significantly more pools, much higher polling frequency, or observed latency/cost regressions in production).

## Repo conventions

- Investigation drafts live in the gitignored `.investigations/<address>-<slug>.md` (repo root, NOT in `docs/`). The `/forensic-report` skill produces them and pushes finished drafts to the `reports` Upstash hash via management MCP — never round-trip through copy-paste. Drafts stay local because they routinely identify individuals + on-chain identities.
- Per-package deeper file maps live in each package's `AGENTS.md` — don't replicate them here.

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

### SessionEnd hook (reflect nudge)

`scripts/agent-session-end-hook.sh` runs on SessionEnd for both Claude Code and Codex. When the session left commits or unstaged changes in the tree, it prints a one-line nudge to run `/reflect` so any new learnings get captured in memory / `AGENTS.md` / `CLAUDE.md` before context is lost. Silent on no-op sessions.

- Claude wiring: `.claude/settings.json` → `hooks.SessionEnd`.
- Codex wiring: `.codex/hooks.json`. Codex auto-disables new hooks until trusted; on first encounter, codex either prompts to trust or you mirror the entry into `~/.codex/hooks.json` and toggle `enabled = true` (set the hash) in `[hooks.state]` of `~/.codex/config.toml`. Or pass `--dangerously-bypass-hook-trust` for automation.

### Status-polling commands use `Monitor`, not `/loop`

For commands that watch a long-running external process (Envio sync, PR CI, deploy progress, etc.), prefer the `Monitor` tool over `/loop` + cron. Monitor runs a single shell script that polls internally at 30–60s and only emits stdout lines (== notifications) on state changes worth surfacing. Cron / `/loop` fires a full Stop turn per interval, which triggers a macOS notification regardless of whether anything changed — a 60-min sync produces ~12 idle notifications, vs 2–3 with Monitor. `babysit-indexer-deploy` and `babysit-pr` are the canonical examples; if you find yourself writing a new "watch X every Y minutes" command, model it on those.

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
- `trunk check <file>` only checks the specified files. That is fine for the path-aware local agent gate, but use `--all` when you need to manually reproduce CI's full-repo Trunk job.
- If `indexer-envio typecheck` fails with "Cannot find module 'generated'", run `./scripts/setup.sh` first

For package-specific workflows (promoting a deployment, adding a contract to the indexer, dashboard chart wiring, infrastructure changes), see the relevant package's `AGENTS.md` — they own the procedural detail.
