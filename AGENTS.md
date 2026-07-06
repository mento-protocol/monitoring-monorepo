---
title: Monitoring Monorepo Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-28
---

# AGENTS.md — Monitoring Monorepo

## Overview

pnpm monorepo with these workspace packages:

- `shared-config/` — `@mento-protocol/monitoring-config`: chain + token metadata (chain ID → treb namespace, chain slug/label, explorer URLs, token-symbol derivation)
- `indexer-envio/` — Envio HyperIndex indexer for Celo v3 FPMM pools
- `ui-dashboard/` — Next.js 16 + Plotly.js monitoring dashboard
- `metrics-bridge/` — Hasura → Prometheus gauge exporter for v3 alert rules
- `integration-probes/` — quote-only aggregator and cross-chain router coverage probes
- `aegis/` — NestJS App Engine service for v2 alerts plus Grafana Alloy collector, dashboards, and alert-rule Terraform
- `governance-watchdog/` — Cloud Function that monitors Mento Governance events on-chain and sends notifications to Discord and Telegram

## Operating Rule (read this before opening PRs)

Context authority, placement, and metadata rules live in
`docs/context-standards.md`. Treat canonical context as current operating truth
and non-canonical notes/plans as historical input that must be verified before
use.

Architecture decisions and the rationale behind the system's shape are recorded
in [`docs/adr/`](docs/adr/README.md) — read the ADR that governs a subsystem
before changing how it is built. When your change **makes** an architectural
decision (it constrains future work, had a real alternative, and the why is not
obvious from the code), record a new ADR in the same PR. `pnpm adr:check` and the
agent quality gate remind you on architectural surfaces (new package, Terraform
stack, or workflow); the when/how procedure is
[`docs/pr-checklists/architecture-decisions.md`](docs/pr-checklists/architecture-decisions.md).

## Cross-Protocol Context

For any protocol-level question that crosses beyond this monitoring repo, first
read the private `mento-master-context` router when the checkout is available.
See `docs/notes/cross-protocol-context.md` for the router path, what it covers,
and the verify-before-use rule.

## Secrets Rule (IaC Before CLI)

Agents must not create, rotate, or overwrite secrets manually with CLI commands
such as `gh secret set`, `vercel env add`, `gcloud secrets versions add`, or
provider-specific secret commands. Always prefer IaC: model the secret in the
owning Terraform stack or the documented owning integration, update the docs in
the same PR, and surface the required human-approved plan/apply step. If the
secret cannot be represented in IaC yet, stop and ask for an IaC path instead of
using a CLI workaround.

## Spoken Attention Nudge

When you need the user's attention and they are not actively responding (blocked
on a decision, waiting on approval for a production mutation, a long task just
finished, or plan feedback is required), send a brief spoken nudge with `sag` in
addition to the normal chat message. See `docs/notes/spoken-attention-nudge.md`
for the fallback ladder, key-file setup, and pre-approval constraints.

Any PR that adds or changes stateful data flow across layers must run the
dedicated PR checklist before opening or updating the PR:

- **Checklist:** `docs/pr-checklists/stateful-data-ui.md`

## Issue-Driven Backlog

GitHub Issues are the canonical active-work queue for agent-addressable work.
Use this query for the next ready item:

```text
is:issue is:open label:agent-ready -label:agent-active -label:in-pr
```

Agent sessions should normally claim work through the repo helper, which keeps
the labels and the repo pilot workboard in sync:

```bash
pnpm issue:claim --count 3 --agent codex
```

`BACKLOG.md` is transition storage only: when a backlog item is migrated, keep
the active task in Issues and leave durable context in `AGENTS.md`,
`docs/pr-checklists/`, `docs/notes/`, or tests. Do not keep the same active
task duplicated in both places.

Queue state labels are mutually exclusive:

- `needs-grooming` — scope, acceptance criteria, dependencies, or human decision
  are missing.
- `agent-ready` — an agent can claim and implement the issue from the issue body.
- `agent-active` — an agent has claimed the issue and is working before or while
  opening a PR.
- `in-pr` — implementation is open in a PR; do not pick up as new work.

When starting issue work, run `pnpm issue:claim` before substantive edits; it
removes `agent-ready`, adds `agent-active`, adds the issue to the repo workboard,
and moves the item to `In Progress`. The repo workboard must have a text
`Claim ID` field so claim ownership can be verified safely. When opening the PR, run
`pnpm issue:review --pr <number> --issue <issue>` to remove `agent-active`, add
`in-pr`, and project the issue into review on the workboard.
Use `Closes #123` only for issues whose "Done means" is fully satisfied by the
PR; otherwise use `Refs #123`. After merge, `pnpm issue:board sync` moves
closed `in-pr` issues that are already on the workboard to `Done` and clears
the queue label. If a PR closes unmerged or only partially ships, run
`pnpm issue:release --issue <issue>` to restore `agent-ready` only when the
remaining acceptance criteria are still clear; otherwise use
`pnpm issue:release --issue <issue> --needs-grooming`.

New agent-ready issues should use `.github/ISSUE_TEMPLATE/agent-task.yml` and
carry routing/risk labels such as `source:backlog`, `pkg:*`, `kind:*`, and
`risk:*`. Detailed lifecycle rules live in
`docs/notes/agent-issue-workflow.md`.

## Agent Quality Gate

Before opening or updating an agent-authored PR, run:

```bash
pnpm agent:quality-gate          # dry-run: maps changed paths to package checks + PR checklists
pnpm agent:quality-gate --run    # executes the mapped local-only commands (lint, typecheck, tests, codegen, Trunk, formatting)
pnpm agent:autoreview            # structured closeout review; batch-boundary verifier for non-trivial batches
pnpm agent:review-materiality    # classify review depth (trivial/standard/full) + likely context-update needs
pnpm agent:prewarm --base origin/main  # warm Turbo's local cache for the same mapped package tasks
```

The gate is local-only (never deploy or Terraform apply) and refuses `--run`
when package manifests, the lockfile, `.npmrc`, pnpmfile, or `patches/**`
changed until you review the script/lifecycle diff and pass
`--allow-package-script-changes`. For parallelism knobs, Turbo caching rules,
the pre-push hook delegation, the package-script refusal exceptions, and
Codex-native review bundle prep, see `docs/notes/agent-quality-gate-mechanics.md`.

## PR description standard

Every PR description must start with these exact heading lines, in this order:

```markdown
## The Problem
```

- Maximum three bullets.
- State the user/operator/reviewer problem in plain English.
- Avoid implementation details unless they are needed to understand the impact.

```markdown
## The Solution
```

- Explain in simple terms how the PR solves that problem.
- Keep this understandable before reading the diff.
- Put deeper implementation notes, invariants, validation, caveats, and issue
  references after these two sections.

The first two sections are not a change log. They are the reviewer-facing story
for why the PR exists and why this approach resolves it.

## Deferral rule

Every time something is knowingly deferred from a PR — a reviewer finding you
chose not to address in that PR, or work you judged out of scope — create a
GitHub issue for it with a clear description of the problem to be solved, plus
solution ideas if you have them (otherwise describe the problem as best you
can). Label it `agent-ready` when an agent could pick it up unaided.

The PR body's `## Deferrals` section is the enforcement point. It is optional:
omit it when nothing was knowingly deferred — there's no need to write the
section just to say "None". When the section is present, the `PR description
format` check requires every item to either say `None` or link a GitHub issue,
so a real deferral can't hide behind an empty declaration. Two corollaries:

- Create the issue **before** posting a "Deferred — tracking in …" review
  reply; a deferred reply without an issue link is incomplete.
- A won't-fix with evidence is **not** a deferral (no issue needed); a "good
  idea, later" is.

## PR feedback sweep rule

Before declaring a PR clean, inspect every GitHub feedback surface: top-level PR/issue comments, review submissions and bodies, inline review threads/comments, check-run annotations, and failing check logs. Bot reviews can post actionable multi-finding reports as top-level comments, not only inline comments. A clean or resolved inline-thread list is necessary but not sufficient.

Hard stop: a PR is not all clear until `chatgpt-codex-connector[bot]` has left
a 👍 reaction on the PR description for the current head, unless a human
maintainer has posted the exact head-scoped break-glass override documented in
`docs/notes/pr-ready-state.md`. A Codex review comment on an older commit,
elapsed grace time, green checks, or another actor's reaction does not satisfy
this gate.

Before signaling all-clear, both Claude Code and Codex babysitting flows must
run the shared readiness probe:

```bash
pnpm pr:ready-state --pr <number> --json
```

For feedback-only sweeps where the agent needs normalized `findings[]`,
unresolved threads, unreplied root review comments, blocking top-level bot
feedback, and Codex review gates without shelling out to ad hoc `gh api` calls,
use:

```bash
pnpm --silent pr:feedback-state --pr <number> --json
```

For an interactive low-noise watch, use:

```bash
pnpm pr:ready-state --pr <number> --watch --compact --until-ready
```

`--until-ready` preserves the same polling output but exits 0 once the PR is
ready or merged, exits nonzero if the PR closes unmerged, and otherwise keeps
polling. Omit it only when you intentionally want the watch to run until manual
interruption.

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

## Docs Drift On Workflow Changes

When adding or changing a command, script, env var, deploy step, hook, or
canonical operator workflow, audit the full live workflow surface before pushing.
Search `AGENTS.md`, package `AGENTS.md` files, `README.md`, `docs/**`,
`.agents/skills/**`, `.claude/skills/**`, `.claude/commands/**`, deploy and
rollback scripts, and babysit commands for the old sequence. Update every
operator path that could still send an agent or human through stale steps.

Treat deploy, rollback, and babysit flows as one family: if a new promotion gate
is added to the deploy path, the rollback checklist and monitor/babysit prompt
usually need the same gate.

## Recurring PR-review patterns

Recurring automated-review hazards are canonicalized in
`docs/pr-checklists/recurring-review-patterns.md`. Explicit repo-local review
exclusions live in `docs/pr-checklists/review-prompt-exclusions.md`; reviewers
should treat that file as the "do not flag" layer before re-raising old or
speculative findings. Read those checklists when a change touches cross-layer
state, CI/deploy behavior, code-health rules, dashboard interaction flows,
security headers, package-manager behavior, or other review-prone surfaces. Keep
root instructions as routing context; put the detailed rules in the checklists.

## Quick Commands

```bash
# Install all deps (gated: pnpm refuses registry versions <3 days old via
# minimumReleaseAge in pnpm-workspace.yaml; @mento-protocol/* is exempted.
# Frozen-lockfile installs are unaffected.)
pnpm install

# Indexer
pnpm indexer:codegen              # Generate types from schema (multichain mainnet: Ethereum reserve-yield + Celo + Monad)
pnpm indexer:dev                   # Start indexer (multichain mainnet: Ethereum reserve-yield + Celo + Monad)
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test    # Codegen mainnet config, run sUSDS/stETH tests, restore mainnet codegen
pnpm indexer:mutation              # Targeted StrykerJS baseline for indexer pure logic
pnpm deploy:indexer                # Push HEAD to envio branch and trigger hosted reindex
pnpm deploy:indexer:status <commit> --watch  # Wait for registration, then watch sync
pnpm deploy:indexer:logs <commit> --level error,warn --since 2h  # Runtime issues
pnpm deploy:indexer:metrics <commit>  # Per-chain hosted indexing progress
pnpm deploy:indexer:info <commit>     # Hosted deployment info/cache state
pnpm deploy:indexer:verify <commit>   # Batch status, metrics, endpoint, and GraphQL row probe
pnpm deploy:indexer:promote <commit>  # Promote a synced deployment to prod
pnpm deploy:indexer:rollback <last-good-sha>  # Roll prod back: re-promote if still registered, else rebuild + resync

# Code health (CodeScene-equivalent OSS checks)
pnpm code-health:knip              # Strict knip across all packages (blocking)
pnpm code-health:knip:report       # Advisory knip (warn-only) — does not exit non-zero
pnpm code-health:deps              # dependency-cruiser: cross-package boundaries + cycles (blocking)
pnpm code-health:deps:graph        # Render the dependency graph to reports/dep-graph.svg (needs graphviz `dot`)
pnpm code-health:history           # CodeScene-style git history report → reports/code-health-history.md
pnpm code-health:duplication       # jscpd duplication report → reports/jscpd/ (advisory, never blocks)
pnpm code-health:schema-diff       # GraphQL schema breaking-change diff vs origin/main (advisory, never blocks)
pnpm code-health                   # Run knip + deps together (everything except history + duplication)
pnpm agent:review-materiality      # Classify review depth + context-update signals for current diff
pnpm agent:autoreview              # Structured closeout review; use --prepare-bundle-dir DIR for Codex-native review bundles
node scripts/review-process-metrics.mjs --before-pr 1034 --limit 20  # Collect review-process baseline metrics
node scripts/review-process-metrics.mjs --after-pr 1045 --limit 20   # Collect review-process check-in metrics
pnpm lockfile:lint                 # Lockfile integrity + registry check (blocking; no install needed)
pnpm skew:check                    # Dependency version-skew check vs the pnpm catalog (blocking; no install needed)
pnpm sanitize:test                 # Fixture tests for scripts/sanitize-terraform-output.sh (terraform output secret redaction)
pnpm override:prune-report          # pnpm.overrides + minimumReleaseAgeExclude pruning report (advisory; no install needed)
pnpm adr:check                      # Advisory ADR reminder for architectural changes (new package/stack/workflow); --strict to hard-gate
pnpm adr:check:test                 # Offline tests for the ADR reminder trigger logic
node scripts/check-github-action-pins.mjs  # Verify workflow/composite-action `uses:` refs are SHA-pinned
node scripts/check-hermetic-vitest-setup.mjs  # Verify all workspace Vitest network guards are byte-identical
node scripts/file-size-watchlist.mjs  # Refresh source file-size watchlist; use --format issue for GitHub Issues, not BACKLOG.md
pnpm indexer:testnet:codegen       # Generate types (multichain testnet: Celo Sepolia + Monad testnet)
pnpm indexer:testnet:dev           # Start indexer (multichain testnet)

# Dashboard
pnpm dashboard:dev            # Dev server; see ui-dashboard/AGENTS.md for logged-in/out localhost verification
pnpm dashboard:build          # Production build
pnpm dashboard:size-limit     # Check bundle size against budgets (run after build)
pnpm --filter @mento-protocol/ui-dashboard test:browser                   # Fixture-driven browser interaction + visual snapshot tests
pnpm --filter @mento-protocol/ui-dashboard test:browser:production        # Build-backed fixture browser tests via next start
pnpm --filter @mento-protocol/ui-dashboard test:browser:update-snapshots # Re-baseline visual snapshots after a legitimate UI change
pnpm dashboard:mutation       # Targeted StrykerJS baseline for dashboard pure logic
pnpm bridge:mutation          # Targeted StrykerJS baseline for metrics-bridge rebalance probe logic

# Aggregator integration probes
pnpm integrations:probe        # Quote-only Mento v3 route coverage snapshot
pnpm integrations:probe --write-upstash  # Publish latest snapshot for /integrations
pnpm integrations:probe:test   # Unit tests for probe adapters/parsers

# Agent issue workboard
pnpm issue:claim --count 3 --agent codex       # Claim ready issues and move them to In Progress
pnpm issue:review --pr 123 --issue 901         # Move claimed issue to in-pr / review
pnpm issue:release --issue 901                 # Release a mistaken claim back to agent-ready
pnpm issue:board sync                          # Re-project labels and close merged in-pr board items
pnpm issue:board:test                          # Offline tests for the issue-board helper

# Aegis
pnpm aegis:dev                # Start the NestJS App Engine service locally
pnpm aegis:build              # Build the Aegis service
pnpm aegis:typecheck          # Typecheck the Aegis service
pnpm aegis:test               # Jest tests
pnpm aegis:lint               # ESLint baseline gate for Aegis
pnpm aegis:deploy             # Build, stage a locked App Engine app, and deploy Aegis to mento-monitoring
pnpm aegis:logs               # Tail Aegis App Engine logs from mento-monitoring
pnpm aegis:agent:seed-secrets # Seed/rotate Alloy remote-write Secret Manager versions
pnpm aegis:agent:deploy       # Deploy the Grafana Alloy App Engine collector
pnpm aegis:tf:init / aegis:tf:plan
# Apply runs in CI on merge to main (aegis-terraform.yml; production-infra gate).

# Infrastructure (Terraform)
pnpm tf list                  # Registered Terraform stacks from terraform.stacks.json
pnpm tf validate <stack>      # fmt/init -backend=false/validate for one stack
pnpm infra:init               # Init providers (first time or after changes)
pnpm infra:plan               # Preview infrastructure changes
pnpm infra:apply              # Apply infrastructure changes
# Event-driven alerts stack (Cloud Functions + Slack channels/usergroups + Sentry bridge + QuickNode webhooks):
pnpm alerts:infra:init / alerts:infra:plan
pnpm alerts:oncall:typecheck / alerts:oncall:test / alerts:oncall:build
# Grafana metric alert rules (v3 Slack rules):
pnpm alerts:rules:lint
pnpm alerts:rules:init / alerts:rules:plan
# Apply happens via CI on merge to main for alerts-rules, alerts-delivery, and Aegis.
# The production-infra gate enforces required-reviewer approval and allows
# self-review for the sole-maintainer workflow.
```

Terraform stack ownership is registered in `terraform.stacks.json` and
documented in `docs/terraform.md`; do not infer ownership from directory names
alone.

**Terraform from a worktree** (e.g. `.claude/worktrees/<name>/`): `pnpm infra:*` scripts don't pass `-var-file`, and `terraform.tfvars` only lives in the main checkout (gitignored). Either run the commands from the main checkout, or from inside the worktree's `terraform/`:

```bash
terraform init -reconfigure   # GCS backend needs reinit in a fresh worktree
terraform plan  -var-file=<main-checkout>/terraform/terraform.tfvars
```

Never `terraform apply` without explicit user approval — plan first, surface the diff, wait for go-ahead. For stacks whose registry entry has `ci.apply == "push-main-production-infra-environment"`, local `pnpm tf apply <stack>` is guarded: it only runs from a clean `main` checkout at `origin/main` or with the deliberate `--force-local-apply` override. CI-driven applies for those stacks are gated by the `production-infra` GitHub Environment manual approval, which counts as explicit human approval.

## Package routing index

Each package has its own `AGENTS.md` (Claude Code reads them as `CLAUDE.md` via symlink). Open the relevant file for package-specific rules, gotchas, and verification.

| Package                | What it does                                                                                                                                                                                                                                                                                                                                                                             | Read                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `aegis/`               | NestJS App Engine service polling v2 view calls → Prometheus `/metrics`; also owns the Aegis Grafana dashboard (`aegis/terraform/`); the Aegis service-health alert rules live in `alerts/rules/`                                                                                                                                                                                        | [`aegis/AGENTS.md`](aegis/AGENTS.md)                             |
| `shared-config/`       | `@mento-protocol/monitoring-config`: chain/token metadata, FX calendar, deployment namespaces. Source of truth — never duplicate chain slugs, explorer URLs, or token labels elsewhere (PR #209). Indexer vendors a copy because Envio builds outside the pnpm workspace.                                                                                                                | [`shared-config/AGENTS.md`](shared-config/AGENTS.md)             |
| `indexer-envio/`       | Envio HyperIndex (envio@3.0.0): Celo + Monad FPMM, v2 Broker, and event-only Ethereum reserve-yield accounting in the primary config. Schema in `schema.graphql`; handler entry point is `src/EventHandlers.ts`.                                                                                                                                                                         | [`indexer-envio/AGENTS.md`](indexer-envio/AGENTS.md)             |
| `ui-dashboard/`        | Next.js 16 + Plotly.js + SWR + Tailwind 4. Address book + forensic reports stored in Upstash (`labels` + `reports` hashes), backed up daily to Vercel Blob.                                                                                                                                                                                                                              | [`ui-dashboard/AGENTS.md`](ui-dashboard/AGENTS.md)               |
| `metrics-bridge/`      | Hasura → Prometheus gauge exporter for v3 alert rules; bounded label cardinality required.                                                                                                                                                                                                                                                                                               | [`metrics-bridge/AGENTS.md`](metrics-bridge/AGENTS.md)           |
| `integration-probes/`  | Quote-only Mento v3 route coverage probes for aggregators and cross-chain routers. Publishes `integration-probes:latest` in Upstash for the dashboard `/integrations` page.                                                                                                                                                                                                              | [`integration-probes/AGENTS.md`](integration-probes/AGENTS.md)   |
| `terraform/`           | Vercel project + Upstash Redis + env vars + Cloud Run services + platform-owned repo Actions secrets. `pnpm infra:plan` before any apply; never apply without human approval.                                                                                                                                                                                                            | [`terraform/AGENTS.md`](terraform/AGENTS.md)                     |
| `alerts/`              | All alert plumbing. `alerts/rules/` = protocol Grafana metric alert rules plus global Grafana routing/contact points/templates; `alerts/infra/` = event-driven delivery (QuickNode→Cloud Fn→Slack + Sentry→Slack bridge + Splunk On-Call rotation announcer + Slack channel lifecycle). `alerts/infra/onchain-event-handler/` and `alerts/infra/oncall-announcer/` are TS pnpm packages. | [`alerts/AGENTS.md`](alerts/AGENTS.md)                           |
| `governance-watchdog/` | Cloud Function monitoring Mento Governance on-chain events; sends Discord + Telegram notifications. Standalone source root with its own `pnpm-lock.yaml` and Cloud Build deploy path.                                                                                                                                                                                                    | [`governance-watchdog/README.md`](governance-watchdog/README.md) |
| `scripts/`             | Deploy wrappers, agent quality gate, code-health checks. `set -euo pipefail`; refuse dirty trees before mutating external systems.                                                                                                                                                                                                                                                       | [`scripts/AGENTS.md`](scripts/AGENTS.md)                         |

### PR Review Guidance (Dashboard Scale)

- Current expected scale is roughly **30–50 total pools**.
- At this size, client-side aggregation for the 24h volume tiles/table is acceptable with the current polling setup.
- Do **not** flag the current snapshot-query aggregation path as a scalability issue in PR reviews unless assumptions change materially (e.g. significantly more pools, much higher polling frequency, or observed latency/cost regressions in production). The canonical exclusion lives in `docs/pr-checklists/review-prompt-exclusions.md`.

## Repo conventions

- Investigation drafts live in the gitignored `.investigations/<address>-<slug>.md` (repo root, NOT in `docs/`). The `/forensic-report` skill produces them and pushes finished drafts to the `reports` Upstash hash via management MCP — never round-trip through copy-paste. Drafts stay local because they routinely identify individuals + on-chain identities.
- Per-package deeper file maps live in each package's `AGENTS.md` — don't replicate them here.

## Environment

- Indexer needs Docker for local dev (Postgres + Hasura containers)
- Dashboard localhost UI review defaults to the live production Envio endpoint
  when `NEXT_PUBLIC_HASURA_URL` is unset. See `ui-dashboard/AGENTS.md` for
  testnet env vars, Upstash/Auth.js local setup, and the logged-in/logged-out
  verification workflow.
- Production env vars are managed by Terraform except Vercel Blob OIDC variables, which are managed by the Vercel store integration — see `terraform/terraform.tfvars.example`
- See root README.md for full env var documentation

## Claude Code Slash Commands

Repo-tracked under `.claude/commands/`. Each `.md` file is the body Claude Code loads when you type `/<filename>`. Add a new one by dropping a markdown file in that directory; remove one by deleting the file.

| Command                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/verify-ui`                         | Drive chrome-devtools MCP through the dashboard's pages with token-budget guidance and per-page acceptance checks (KPI presence, chart wiring, interaction smoke tests, responsive layouts). Defaults to a localhost dev server; pass `prod` to verify against `monitoring.mento.org`. For session-dependent surfaces, verify both logged-out and locally simulated logged-in states per `ui-dashboard/AGENTS.md`.                                                                                                                                                                                       |
| `/autoreview [args]`                 | Run the shared structured closeout review helper (`pnpm agent:autoreview`) from Claude Code. Normal shells default to Codex as the review engine; active Codex sandboxes default to the local deterministic engine unless an engine is passed explicitly.                                                                                                                                                                                                                                                                                                                                                |
| `/babysit-indexer-deploy [<commit>]` | Arm a `Monitor` that polls Envio's deployment registry every 45s internally but only emits on state change (`REGISTERED` / `READY_TO_PROMOTE` / `BUILD_FAILED` / `SYNC_DEADLINE` / `ERROR`). Prompts for `pnpm deploy:indexer:verify <commit>` and then `pnpm deploy:indexer:promote <commit>` once every chain is caught up — never auto-promotes. Bails after 30min of 404s (build likely failed) or 90min of stagnation. Defaults to `git rev-parse --short origin/envio` when no commit is passed. Replaces the prior `/loop 5m` cron version, which produced ~12 idle macOS notifications per sync. |

To use them you need [Claude Code](https://claude.com/claude-code). Personal/local-only commands belong in your own `~/.claude/commands/` (or in `.git/info/exclude` if you want to keep them in this directory but not share).

## Codex Agent Skills

Repo-tracked project skills live under `.agents/skills/`. Keep durable,
team-shareable project workflows there instead of relying on local-only
`~/.codex` or `~/.claude` state. Cross-project personal skills belong in
`~/.agents/skills` and should be exposed to both agents through the
`~/.codex/skills` and `~/.claude/skills` mirrors. Project-level Codex MCP config
lives in `.codex/config.toml`; local personal Codex settings still belong in
`~/.codex/config.toml`.

`autoreview` is pinned in this repo through `scripts/agent-autoreview.mjs` and
exposed with `pnpm agent:autoreview`; Claude Code also has `/autoreview` as a
thin command shim. Codex Cloud setup/maintenance use
`./scripts/codex-cloud-setup.sh` / `./scripts/codex-cloud-maintenance.sh`. See
`docs/notes/codex-agent-skills.md` for the autoreview engine-detection and
bundle-prep mechanics, Codex Cloud setup detail, the `ship`/`babysit-pr` skill
adapters, the SessionEnd reflect-nudge hook, and why status-polling commands
use `Monitor` instead of `/loop`.

## New Worktree / Clone Setup

After creating a new worktree manually or cloning the repo, run
`./scripts/setup.sh`. See `docs/notes/worktree-and-web-setup.md` for what it
installs/verifies and the Worktrunk `pre-start` hook wiring.

## Claude Code on the web setup

Claude Code on the web sessions run in a hosted container that bootstraps
itself through a SessionStart hook delegating to
`./scripts/claude-code-web-setup.sh`. See `docs/notes/worktree-and-web-setup.md`
for the hosted-container bootstrap contract, the Playwright fallback behavior,
and the `babysit-pr` `Monitor` fallback.

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
pnpm --filter @mento-protocol/indexer-envio test:coverage
pnpm indexer:codegen   # Validates Envio can parse handler entry point + module imports
pnpm --filter @mento-protocol/ui-dashboard test:coverage
```

Before pushing any cross-layer or stateful UI change, also read and apply:

- **`docs/pr-checklists/stateful-data-ui.md`**

See `docs/notes/agent-quality-gate-mechanics.md` for common local-gate traps
(codespell false positives, `trunk check` scoping, missing `generated` module).

For package-specific workflows (promoting a deployment, adding a contract to the indexer, dashboard chart wiring, infrastructure changes), see the relevant package's `AGENTS.md` — they own the procedural detail.
