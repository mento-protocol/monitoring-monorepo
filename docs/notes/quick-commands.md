---
title: Quick Commands
status: active
owner: eng
canonical: true
last_verified: 2026-09-03
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
pnpm deploy:indexer:promote <commit>  # Promote a synced deployment to prod
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
# Normal delivery uses the direct author checks in pr-operating-card step 3.
pnpm agent:quality-gate            # Optional legacy diagnostic: inspect its retained mapping
pnpm agent:quality-gate --run      # Optional legacy diagnostic: execute its retained mapping
pnpm agent:context-check           # Validate repo-visible agent instructions, links, and routing
pnpm agent:review-materiality      # Classify review depth + context-update signals for current diff
pnpm agent:closeout-review --base "$BASE_REMOTE/$baseRefName"  # Requires the preflight-bound variables; prints `report: <path>`; exit 1 = findings, 2 = closeout failed
pnpm agent:closeout-review:test    # Suite for the closeout review tool
pnpm review:eval:experiment -- --help  # Non-ledger paired screen; canonical qualification reruns all 24 cells
pnpm review:eval:experiment -- --validate-plan <campaign-dir> --json  # Validate one candidate campaign without a model call
pnpm review:eval:experiment -- --run <campaign-dir> --stage screen --dry-run --json  # List paid lanes without a model call
pnpm docs:index --write            # Regenerate docs/README.md from tracked + non-ignored untracked Markdown
pnpm docs:index --check            # Fail on catalog drift, invalid classification, or broken internal Markdown links
pnpm docs:audit --dry-run          # Print this week's bounded semantic-review packet without mutating documentation
pnpm docs:garden --dry-run --json  # Read the queue; preview the exact weekly garden issue decision; no mutation
pnpm docs:navigation-eval -- --check-fixtures  # Check fresh-agent navigation questions, routes, and budgets
pnpm docs:navigation-eval -- --prompt          # Print the bounded read-only prompt; no model call
pnpm docs:navigation-eval -- --prompt --base-commit <full-sha>  # Pin a committed result to a reachable default-branch ancestor
pnpm docs:navigation-eval -- --validate <result.json>  # Recompute authority, evidence, route, and context scores
pnpm ci:contract:test             # Test fixed CI, protected no-skip admission and drift, cache, base, and aggregate contracts
bash scripts/bootstrap/agent-setup-contract.test.sh  # Test retained SessionEnd, setup-marker, and package-policy behavior
node --test scripts/indexer-handler-invariant-contract.test.mjs  # Test retained indexer handler invariant owners and schema
# For each approved #2128 post-cutover canary proof, read the current immutable inputs:
gh pr view <pr> --repo mento-protocol/monitoring-monorepo --json number,state,headRefOid,baseRefName,baseRefOid,headRepositoryOwner
# The audit refuses a stale baseRefOid. Update or rebase the PR branch, then read fresh inputs.
# Do not dispatch no-skip for package-execution or evidence-instrument drift. Package drift can use ordinary-force-all evidence. Instrument drift cannot count.
# Stop after any run exceeds 45 runner-minutes. Do not exceed 450 cumulative runner-minutes.
gh workflow run no-skip-audit.yml --repo mento-protocol/monitoring-monorepo --ref main -f pr_number=<pr> -f source_sha=<headRefOid> -f base_sha=<baseRefOid>
pnpm verification:inventory:check  # Validate Phase 0 inventory schema, unique IDs, and complete dispositions
pnpm verification:manifest:write   # Regenerate the terminal pre-M1 gate-rooted control-plane baseline manifest
pnpm verification:manifest:check   # Recompute and compare the terminal pre-M1 baseline manifest
pnpm verification:evidence:check   # Test the Phase 0 checker, replay the source patch, and run both non-writing evidence checks
pnpm agent:context-budget --strict # Enforce root, scoped-file, and aggregate-route AGENTS byte caps
# Run feedback-state first. Final all-clear needs the current-head Codex
# PR-description +1 or this exact-head human override:
# /pr-ready-override gate=codex-description-approval head=<full-head-sha> reason=<why this is safe>
pnpm --silent pr:feedback-state --pr 123 --json  # Normalize unresolved/reply-required feedback before all-clear
pnpm pr:ready-state --pr 123 --json              # Final current-head required-readiness probe
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
pnpm issue:claim --count 3 --agent codex       # Claim ready issues, record ownership, preserve Project Status
pnpm issue:claim --issue 901 --agent codex --branch fix/901 --claim-id sweep-901 --sweep-eligible --body-sha256 <digest> # Claim one inspected sweep snapshot
pnpm issue:groom --issue 901 --add-label pkg:tooling,kind:workflow # Add routing labels under the per-issue mutex; refuses a write that completes sweep eligibility, an owned issue, or an undefined label
pnpm issue:review --pr 123 --issue 901         # Move claimed issue to in-pr / review
pnpm issue:review --pr 123 --issue 901 --claim-id <id> --rebind-branch # Prove and bind a PR branch created after claim
pnpm issue:release --issue 901 --claim-id <id> # Release the matching claim back to agent-ready
pnpm issue:release --issue 901 --claim-id <id> --closed-unmerged-pr # Release after the stored PR closes unmerged
pnpm issue:release --issue 901 --claim-id <id> --merged-pr --needs-grooming # Continue a still-open issue after its stored PR merges
pnpm issue:board sync --dry-run                # Preview the repository-wide projection; reports incompletely groomed agent-ready issues
pnpm issue:board sync                          # Apply the authorized projection; preserve Project Status
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
