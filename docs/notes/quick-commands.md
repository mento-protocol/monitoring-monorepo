---
title: Quick Commands
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Quick Commands

The root `AGENTS.md` quick-command pointer lives in the "Quick Commands"
section. Keep this reference current when adding, renaming, or removing common
repo commands.

```bash
# Install all deps (gated: pnpm refuses registry versions <3 days old via
# minimumReleaseAge in pnpm-workspace.yaml, including new frozen-lockfile
# entries; @mento-protocol/* and reviewed security releases are exempted.)
pnpm install

# Indexer
pnpm indexer:codegen              # Generate types from schema (multichain mainnet: Ethereum reserve-yield + Celo + Monad + Polygon)
pnpm indexer:dev                   # Start indexer (multichain mainnet: Ethereum reserve-yield + Celo + Monad + Polygon)
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test    # Codegen mainnet config, run sUSDS/stETH tests, restore mainnet codegen
pnpm indexer:mutation              # Targeted StrykerJS baseline for indexer pure logic
pnpm deploy:indexer                # Push HEAD to envio branch and trigger hosted reindex
pnpm deploy:indexer:status <commit> --watch --compact  # Low-noise wait for registration + sync
pnpm deploy:indexer:logs <commit> --level error,warn --since 2h  # Runtime issues
pnpm deploy:indexer:metrics <commit>  # Per-chain hosted indexing progress
pnpm deploy:indexer:info <commit>     # Hosted deployment info/cache state
pnpm deploy:indexer:perf <commit>     # Combined status/metrics/log snapshot for perf comparisons
pnpm deploy:indexer:verify <commit>   # Gate promotion on sync, core rows, and Polygon replay semantics
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
pnpm agent:quality-gate            # Map changed paths to required local checks and PR checklists
pnpm agent:quality-gate --run      # Execute the mapped local-only checks
pnpm agent:context-check           # Validate repo-visible agent instructions, links, and routing
pnpm agent:review-materiality      # Classify review depth + context-update signals for current diff
pnpm agent:autoreview              # Isolated closeout review; multi-pass uses --prepare-bundle-dir DIR + one fresh-context reviewer; quality gate owns tests
pnpm agent:autoreview:test         # Full autoreview regression families; defaults to up to 3 workers with progress + timings
pnpm agent:autoreview:test -- --jobs 1  # Sequential full closeout for autoreview runtime changes
pnpm agent:autoreview --verify-bundle-dir DIR  # Pre-review rehash; retain the printed manifest digest
pnpm agent:autoreview --verify-bundle-dir DIR --expected-bundle-manifest DIGEST  # Bound post-review rehash
pnpm docs:index --write            # Regenerate docs/README.md from tracked + non-ignored untracked Markdown
pnpm docs:index --check            # Fail on catalog drift, invalid classification, or broken internal Markdown links
pnpm docs:audit --dry-run          # Print this week's bounded semantic-review packet without mutating documentation
pnpm docs:garden --dry-run --json  # Read the garden queue and preview the exact weekly issue decision without mutations
pnpm docs:navigation-eval -- --check-fixtures  # Validate fresh-agent navigation questions, routes, and budgets
pnpm docs:navigation-eval -- --prompt          # Print the bounded read-only evaluation prompt; never invokes a model
pnpm docs:navigation-eval -- --prompt --base-commit <full-sha>  # Pin a committed result to a reachable default-branch ancestor
pnpm docs:navigation-eval -- --validate <result.json>  # Recompute authority, evidence, route, and context scores
pnpm agent:context-budget --strict # Enforce root, scoped-file, and aggregate-route AGENTS byte caps
pnpm --silent pr:feedback-state --pr 123 --json  # Normalize unresolved/reply-required feedback before all-clear
pnpm pr:ready-state --pr 123 --json              # Final current-head required-readiness probe
node scripts/review-process-metrics.mjs --help  # Start a newly scoped evaluation with a new boundary, cohort, and tracking issue
pnpm lockfile:lint                 # Fail-closed integrity + registry + override-floor check; no install needed
pnpm skew:check                    # Fail on dependency version skew vs the pnpm catalog; no install needed
pnpm sanitize:test                 # Fixture tests for scripts/sanitize-terraform-output.sh (terraform output secret redaction)
pnpm override:prune-report          # pnpm.overrides + minimumReleaseAgeExclude pruning report (advisory; no install needed)
pnpm adr:check                      # Advisory ADR reminder for architectural changes (new package/stack/workflow); --strict to hard-gate
pnpm adr:check:test                 # Offline tests for the ADR reminder trigger logic
node scripts/check-github-action-pins.mjs  # Verify workflow/composite-action `uses:` refs are SHA-pinned
node scripts/check-hermetic-vitest-setup.mjs  # Verify all workspace Vitest network guards are byte-identical
node scripts/file-size-watchlist.mjs  # Refresh source file-size watchlist; use --format issue for GitHub Issues, not BACKLOG.md
pnpm indexer:testnet:codegen       # Generate types (multichain testnet: Celo Sepolia + Monad testnet + Polygon Amoy)
pnpm indexer:testnet:dev           # Start indexer (multichain testnet)

# Dashboard
pnpm dashboard:dev            # Dev server; see docs/notes/dashboard-verification.md for auth-state verification
pnpm dashboard:codegen        # Generate dashboard GraphQL operation types from indexer-envio/schema.graphql
pnpm dashboard:build          # Production build
pnpm dashboard:size-limit     # Check bundle size against budgets (run after build)
pnpm dashboard:lighthouse:pool-fixture # Production-build canonical pool Lighthouse: deterministic fixture, delayed breaker revalidation, blocking 1 700 ms median LCP
pnpm --filter @mento-protocol/ui-dashboard test:browser                   # Fixture browser + visual snapshot tests against a cached next build served by next start
pnpm --filter @mento-protocol/ui-dashboard test:browser:production        # Same, but force a fresh fixture build first
pnpm --filter @mento-protocol/ui-dashboard test:browser:update-snapshots # Re-baseline visual snapshots after a legitimate UI change
pnpm dashboard:mutation       # Targeted StrykerJS baseline for dashboard pure logic
pnpm bridge:mutation          # Targeted StrykerJS baseline for metrics-bridge rebalance probe logic

# Aggregator integration probes
pnpm integrations:probe        # Quote-only Mento v3 route coverage snapshot
pnpm integrations:probe --write-upstash  # Publish latest snapshot for /integrations
pnpm integrations:probe:test   # Unit tests for probe adapters/parsers

# Agent issue workboard
# (Claude cloud sessions without the capability gate: MCP fallback in
# docs/notes/github-tooling-surfaces.md)
pnpm issue:claim --count 3 --agent codex       # Claim ready issues and move them to In Progress
pnpm issue:review --pr 123 --issue 901         # Move claimed issue to in-pr / review
pnpm issue:release --issue 901                 # Release a mistaken claim back to agent-ready
pnpm issue:board sync                          # Re-project labels and close merged in-pr board items
pnpm issue:board:test                          # Offline tests for the issue-board helper

# Sentry triage pipeline (Stage A — deterministic ingest; Stage B — read-only triage + digest; ADR 0036)
pnpm sentry:ingest --dry-run                   # Print queue-issue mutations without applying (needs local SENTRY_TRIAGE_TOKEN)
pnpm sentry:ingest:test                        # Offline tests for the ingest helper (docs/notes/sentry-triage-pipeline.md)
pnpm sentry:digest:test                        # Offline tests for the per-run Slack verdict-digest collector
SENTRY_TRIAGE_ISSUES='[123]' pnpm sentry:digest --channel '#engineering'  # Print the Slack digest payload for a batch (needs gh auth; does not post)

# Public config package
pnpm --filter @mento-protocol/config build     # Build the public protocol metadata package
npm pack ./shared-config --dry-run             # Inspect the files that would publish to npm
# First-time bootstrap: an npm maintainer must seed @mento-protocol/config once,
# then configure trusted publishing for workflow filename `publish-config.yml`
# in repository `mento-protocol/monitoring-monorepo`.
# Manual workflow_dispatch runs validate and pack only; only config-v* tags publish.
git tag "config-v$(node -p "require('./shared-config/package.json').version")"  # Create the publish tag from main
git push origin "config-v$(node -p "require('./shared-config/package.json').version")"  # Publish via .github/workflows/publish-config.yml

# Aegis
pnpm aegis:dev                # Start the NestJS App Engine service locally
pnpm aegis:build              # Build the Aegis service
pnpm aegis:typecheck          # Typecheck the Aegis service
pnpm aegis:test               # Jest tests
pnpm aegis:lint               # ESLint baseline gate for Aegis
pnpm aegis:deploy             # Build, stage a locked App Engine app, and deploy Aegis to mento-monitoring
pnpm aegis:logs               # Tail Aegis App Engine logs from mento-monitoring
# Alloy deploy requires existing enabled secrets and a verified runtime identity.
# Bootstrap/rotation remains blocked by open owner-decision issue #1473; never run the legacy seed command.
pnpm aegis:agent:deploy       # Deploy the already provisioned Alloy collector
pnpm aegis:tf:init
pnpm aegis:tf:plan
# Apply runs in CI on merge to main (aegis-terraform.yml; production-infra gate).

# Infrastructure (Terraform)
pnpm tf list                  # Registered Terraform stacks from terraform.stacks.json
pnpm tf validate <stack>      # fmt/init -backend=false/validate for one stack
pnpm infra:init               # Init providers (first time or after changes)
pnpm infra:plan               # Preview infrastructure changes
# Never run apply without explicit human approval. Plan first and surface the diff.
pnpm infra:apply              # Apply infrastructure changes
# Event-driven alerts stack (Cloud Functions + Slack channels/usergroups + Sentry bridge + QuickNode webhooks):
pnpm alerts:infra:init
pnpm alerts:infra:plan
pnpm alerts:oncall:typecheck
pnpm alerts:oncall:test
pnpm alerts:oncall:build
# Grafana metric alert rules (v3 Slack rules):
pnpm alerts:rules:lint
pnpm alerts:rules:init
pnpm alerts:rules:plan
# Apply happens via CI on merge to main for alerts-rules, alerts-delivery, and Aegis.
# The production-infra gate enforces required-reviewer approval and allows
# self-review for the sole-maintainer workflow. This is operator acknowledgement
# of the commit and earlier plan, not independent or exact apply-plan review.

# Dev janitor
bash scripts/dev-janitor.sh            # Dry-run: report stale trunk repo caches, pnpm store, git worktrees, /private/tmp trees
bash scripts/dev-janitor.sh --apply    # Delete stale trunk repo caches, prune pnpm store, and run git worktree prune
```
