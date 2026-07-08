---
title: Quick Commands
status: active
owner: eng
canonical: true
last_verified: 2026-07-08
---

# Quick Commands

The root `AGENTS.md` quick-command pointer lives in the "Quick Commands"
section. Keep this reference current when adding, renaming, or removing common
repo commands.

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
pnpm dashboard:codegen        # Generate dashboard GraphQL operation types from indexer-envio/schema.graphql
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

# Public config package
pnpm --filter @mento-protocol/config build     # Build the public protocol metadata package
npm pack ./shared-config --dry-run             # Inspect the files that would publish to npm
# Before the first publish tag, configure npm trusted publishing for workflow
# filename `publish-config.yml` in repository `mento-protocol/monitoring-monorepo`.
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
# Secrets are IaC-first; do not create, rotate, or overwrite them manually
# unless the owning integration/runbook explicitly allows the path.
pnpm aegis:agent:seed-secrets # Seed/rotate Alloy remote-write Secret Manager versions
pnpm aegis:agent:deploy       # Deploy the Grafana Alloy App Engine collector
pnpm aegis:tf:init / aegis:tf:plan
# Apply runs in CI on merge to main (aegis-terraform.yml; production-infra gate).

# Infrastructure (Terraform)
pnpm tf list                  # Registered Terraform stacks from terraform.stacks.json
pnpm tf validate <stack>      # fmt/init -backend=false/validate for one stack
pnpm infra:init               # Init providers (first time or after changes)
pnpm infra:plan               # Preview infrastructure changes
# Never run apply without explicit human approval. Plan first and surface the diff.
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
