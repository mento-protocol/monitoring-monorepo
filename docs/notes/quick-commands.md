---
title: Quick Commands
status: active
owner: eng
canonical: true
last_verified: 2026-08-26
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Quick Commands

The root `AGENTS.md` points here from its "Quick Commands" section. Update this
file when a common repo command changes.

```bash
# pnpm-workspace.yaml minimumReleaseAge blocks registry versions under 3 days,
# including new frozen-lockfile entries; @mento-protocol/* and reviewed security releases are exempt.
pnpm install

# Indexer: mainnet covers Ethereum reserve-yield, Celo, Monad, Polygon
pnpm indexer:codegen              # Generate schema types
pnpm indexer:dev                  # Start mainnet indexer
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test    # Codegen mainnet config, test sUSDS/stETH, restore mainnet codegen
pnpm indexer:mutation              # Targeted StrykerJS baseline for indexer pure logic
pnpm deploy:indexer                # Push HEAD to envio branch and trigger hosted reindex
pnpm deploy:indexer:status <commit> --watch --compact  # Low-noise registration + sync wait
pnpm deploy:indexer:logs <commit> --errors-only --since 2h  # Errors; narrow --since if 100 records fill the page
pnpm deploy:indexer:metrics <commit>  # Per-chain hosted indexing progress
pnpm deploy:indexer:info <commit>     # Hosted deployment info/cache state
pnpm deploy:indexer:perf <commit>     # Combined status/metrics/log snapshot for perf comparisons
pnpm deploy:indexer:verify <commit>   # Require sync, core rows, schema-compatible sUSDS baseline/sampler integrity, and Polygon replay
# STOP: A monitor-only, preload, or readiness request is not promotion approval.
pnpm deploy:indexer:promote <commit>  # Requires explicit user approval; promote the verified candidate to prod
pnpm deploy:indexer:verify <commit> --prod  # After propagation, match fixed-endpoint _meta identity to target; verify semantic data
pnpm deploy:indexer:rollback <last-good-sha>  # Restore prod: re-promote if registered, else rebuild + resync

# Code health (CodeScene-equivalent OSS checks)
pnpm code-health:knip              # Strict all-package knip; blocking
pnpm code-health:knip:report       # Warn-only knip; never exits non-zero
pnpm code-health:deps              # dependency-cruiser cross-package boundaries + cycles; blocking
pnpm code-health:deps:graph        # Write reports/dep-graph.svg; needs graphviz `dot`
pnpm code-health:history           # CodeScene-style git history → reports/code-health-history.md
pnpm code-health:duplication       # jscpd duplication → reports/jscpd/; advisory, never blocks
pnpm code-health:schema-diff       # GraphQL breaking-change diff vs origin/main; advisory, never blocks
pnpm code-health                   # Run knip + deps; exclude history + duplication
pnpm agent:quality-gate            # Map changed paths to required local checks and PR checklists
pnpm agent:quality-gate --run      # Run mapped checks through the fair coordinator; default capacity 3
# Package scripts, package-manager settings, and lockfiles can change install code. Review before acknowledgment:
pnpm agent:quality-gate --run --allow-package-script-changes
pnpm agent:context-check           # Validate repo-visible agent instructions, links, and routing
pnpm agent:review-materiality      # Classify review depth + context-update signals for current diff
pnpm agent:autoreview              # Isolated closeout; multi-pass uses --prepare-bundle-dir DIR + a fresh reviewer; gate owns tests
pnpm agent:autoreview:test         # Full regressions; defaults to up to 3 workers with progress + timings
pnpm agent:autoreview:test -- --jobs 1  # Sequential full closeout for autoreview runtime changes
pnpm agent:autoreview --verify-bundle-dir DIR  # Pre-review rehash; retain the printed manifest digest
pnpm agent:autoreview --verify-bundle-dir DIR --expected-bundle-manifest DIGEST  # Bound post-review rehash
pnpm docs:index --write            # Regenerate docs/README.md from tracked + non-ignored untracked Markdown
pnpm docs:index --check            # Fail on catalog drift, invalid classification, or broken internal Markdown links
pnpm docs:audit --dry-run          # Print this week's bounded semantic-review packet without mutating documentation
pnpm docs:garden --dry-run --json  # Read the queue; preview the exact weekly garden issue decision; no mutation
pnpm docs:navigation-eval -- --check-fixtures  # Check fresh-agent navigation questions, routes, and budgets
pnpm docs:navigation-eval -- --prompt          # Print the bounded read-only prompt; no model call
pnpm docs:navigation-eval -- --prompt --base-commit <full-sha>  # Pin a committed result to a reachable default-branch ancestor
pnpm docs:navigation-eval -- --validate <result.json>  # Recompute authority, evidence, route, and context scores
pnpm verification:inventory:check  # Validate Phase 0 inventory schema, unique IDs, and complete dispositions
pnpm verification:manifest:write   # Regenerate the terminal pre-M1 gate-rooted control-plane baseline manifest
pnpm verification:manifest:check   # Recompute and compare the terminal pre-M1 baseline manifest
pnpm verification:evidence:check   # Run the Phase 0 checker suite plus both non-writing evidence checks
pnpm agent:context-budget --strict # Enforce root, scoped-file, and aggregate-route AGENTS byte caps
# Run feedback-state first. Final all-clear needs the current-head Codex
# PR-description +1 or this exact-head human override:
# /pr-ready-override gate=codex-description-approval head=<full-head-sha> reason=<why this is safe>
pnpm --silent pr:feedback-state --pr 123 --json  # Normalize unresolved/reply-required feedback before all-clear
pnpm pr:ready-state --pr 123 --json              # Final current-head required-readiness probe
pnpm pr:merge --pr 123   # Human-only sanctioned merge; --not-ready-reason "<why>" overrides
node scripts/pr/review-process-metrics.mjs --prs <pr1,pr2,...> --output <result.json>  # Collect a new cohort after defining its boundary and tracking issue
pnpm lockfile:lint                 # Fail-closed integrity/registry/override-floor check; no install
pnpm skew:check                    # Fail on dependency skew vs pnpm catalog; no install
pnpm sanitize:test                 # Fixture-test scripts/sanitize-terraform-output.sh secret redaction
pnpm deploy-staging:test           # ADR 0053 source-staging contract; also in `pnpm tf:test`
pnpm override:prune-report          # Advisory pnpm.overrides + minimumReleaseAgeExclude prune report; no install
pnpm adr:check                      # Advisory architecture reminder for new package/stack/workflow; --strict blocks
pnpm adr:check:test                 # Offline ADR-reminder tests
node scripts/workflows/check-github-action-pins.mjs  # Verify SHA-pinned workflow/composite-action `uses:`
node scripts/repo-health/check-hermetic-vitest-setup.mjs  # Verify byte-identical workspace Vitest network guards
node scripts/repo-health/check-guardrail-prose.mjs  # Verify scripts/repo-health/guardrail-prose.json text in AGENTS.md + operating card
node scripts/repo-health/file-size-watchlist.mjs  # Refresh package src/scripts source watchlist; --format issue targets GitHub, not BACKLOG.md
pnpm indexer:testnet:codegen       # Generate types (multichain testnet: Celo Sepolia + Monad testnet + Polygon Amoy)
pnpm indexer:testnet:dev           # Start indexer (multichain testnet)

# Dashboard
pnpm dashboard:dev            # Dev server; auth-state checks: docs/notes/dashboard-verification.md
pnpm dashboard:codegen        # Generate GraphQL operation types from indexer-envio/schema.graphql
pnpm dashboard:build          # Production build
pnpm dashboard:size-limit     # Check post-build bundle budgets
pnpm dashboard:lighthouse:pool-fixture # Blocking deterministic production-build canonical pool fixture; delayed breaker revalidation; 1 700 ms median LCP
pnpm --filter @mento-protocol/ui-dashboard test:browser                   # Fixture browser + visual snapshot tests on cached next build via next start
pnpm --filter @mento-protocol/ui-dashboard test:browser:production        # Same with a fresh fixture build
pnpm --filter @mento-protocol/ui-dashboard test:browser:update-snapshots # Rebaseline legitimate visual snapshot changes
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
pnpm issue:board sync --dry-run                # Preview the repository-wide queue-label and Project projection
pnpm issue:board sync                          # Apply an explicitly authorized repository-wide projection
pnpm issue:board backfill --issue 901 --dry-run # Preview fill-only ownership-field recovery from a trusted claim comment
pnpm issue:board:test                          # Offline tests for the issue-board helper

# Sentry triage pipeline (Stage A — deterministic ingest; Stage B — read-only triage + digest; ADR 0036)
pnpm sentry:ingest --dry-run                   # Print queue-issue mutations without applying (needs local SENTRY_TRIAGE_TOKEN)
pnpm sentry:ingest:test                        # Offline tests for the ingest helper (docs/notes/sentry-triage-pipeline.md)
pnpm sentry:digest:test                        # Offline tests for the per-run Slack verdict-digest collector
pnpm sentry:broker:test                        # Offline tests for the triage agent's loopback credential broker (ADR 0056)
SENTRY_TRIAGE_ISSUES='[123]' pnpm sentry:digest --channel '#sentry-triage'  # Print a batch's Slack digest payload (gh auth; does not post)

# Public config package
pnpm --filter @mento-protocol/config build     # Clean-build the public protocol metadata package
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
# Alloy: the scoped runbook owns write-only inputs, no-seed/--migrate rules,
# and the stop-before-start handoff.
pnpm aegis:agent:preflight -- --static-only # Static contract only
pnpm aegis:agent:test
pnpm aegis:agent:deploy                    # Deploy from clean current main
pnpm aegis:tf:init                         # Grafana folder/dashboard stack
pnpm aegis:tf:plan

# Infrastructure (Terraform)
# `terraform.stacks.json` owns routing. `platform` uses human-approved local
# apply; `peg-policy-publication` is workflow-only. Other stacks normally apply
# on `main` behind `production-infra`; local apply needs clean current `main` or
# deliberate `--force-local-apply`.
pnpm tf list                  # Registered Terraform stacks from terraform.stacks.json
pnpm tf validate <stack>      # fmt/init -backend=false/validate for one stack
pnpm infra:init               # Init providers (first time or after changes)
pnpm infra:plan               # Plan a committed snapshot from clean current main
pnpm infra:apply -- -auto-approve # Exact checked plan; explicit human approval required
# Event-driven alerts stack (Cloud Functions + Slack channels/usergroups + Sentry bridge + QuickNode webhooks):
pnpm alerts:infra:init
pnpm alerts:infra:plan
pnpm alerts:oncall:typecheck
pnpm alerts:oncall:test
pnpm alerts:oncall:build
# Grafana metric alert rules (v3 Slack rules):
pnpm alerts:rules:lint
pnpm tf validate alerts-rules
pnpm alerts:rules:init
pnpm alerts:rules:plan
# CI applies alerts-rules, alerts-delivery, and Aegis after `production-infra`
# reviewer approval; that acknowledges the commit and earlier plan, not the exact apply plan.

# Dev janitor
bash scripts/repo-health/dev-janitor.sh          # Dry-run: report stale trunk repo caches, pnpm store, git worktrees, /private/tmp trees
bash scripts/repo-health/dev-janitor.sh --apply  # Delete stale trunk repo caches, prune pnpm store, and run git worktree prune
```
