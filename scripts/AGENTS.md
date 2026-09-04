---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
doc_type: agent-instructions
scope: scripts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Scripts

Read the relevant [ADR](../docs/adr/README.md) before changing script behavior.

## Scope

`scripts/` holds repository tools.

## Layout

[ADR 0064](../docs/adr/0064-scripts-module-directories.md) governs these
subdirectories.

- `deploy/`: deploy wrappers and Node helpers
- `workflows/`: Actions workflow support
- `bootstrap/`: setup scripts and retained setup/package-policy contract
- `context/`: agent context, budget, doc catalog
- `docs/`: audit, garden, navigation, verification evidence
- `pr/`: PR and issue state projections
- `supply-chain/`: lockfile, audit, pin, skew gates
- `mcp/`: MCP broker, launcher, config rendering
- `alerts/`: alert-rule lint, peg-policy checks
- `repo-health/`: code-health, file-size, lint
- `terraform/`: movable Terraform guards/helpers
- `gate/`: routing engine + coordinator
- `sentry/`: triage/autofix/gate/broker/ci-wiring

`lib/` and `production-infra-identity-contract/` predate the reorg.
`.config/wt.toml` and eight docs pin flat `setup.sh`.
`redrive-onchain-deadletter.{mjs,test.mjs}` stays flat under
`alerts/infra/`; ADR 0064 gives the lint reason.

`lib/` holds shared cores: `hcl.mjs` (Terraform HCL),
`workflow-yaml.mjs` (Actions and shell parsing), `pnpm-override-selector.mjs`
(pnpm overrides), and `gh-issue-lifecycle.mjs` (GitHub issue and label
mechanics). Doc schedulers also read the last one. Local projection keeps only
`agent-ready` on create and all lifecycle labels on closed repair. ADR 0064 lists
readers.
`peg-policy-digest.mjs` defines the peg version-digest contract for both
validators. Inventories, pinned hashes, and identities stay with their domain.

## Why Files Stay Flat

Move each pin class with its files. Keep `agent-autoreview.sh` feedback pins.

- **Autoreview pins.** `agent-autoreview.sh` pins runtime,
  sealed `agent-autoreview-secret-suppressions.json` (ADR 0079),
  `pr-feedback-state-claude.mjs` and
  `pr-ready-state-review-signals.mjs`; feedback uses `origin/main`. Use ADR
  0064's three-merge sequence.
- **Gate routing pins.** Stub-repo tests require
  `$script_source_dir == $repo_root/scripts`.
  `bootstrap/codex-cloud-setup.{sh,test.sh}` pair offline.
  `sentry/autofix/sentry-autofix-refused-inventory.mjs` routes
  `pnpm sentry:autofix:{run-record,finalize}:test`. Exact
  `sentry/triage/sentry-triage-project-route.mjs` routes
  `pnpm sentry:project:test`.
  `deploy/deploy-indexer-verify{,-analysis}{,.test}.mjs` and
  `deploy/deploy-indexer-verify-status-identity.mjs` share an any-depth arm;
  both run. `pr/agent-issue-board{,.test}.mjs` and
  `pr/issue-board-{backfill,cli,commands,groom,lock,ownership,projects,release,state,sync{,-lock},transactions,transport}.mjs`
  route `pnpm issue:board:test`; CI reruns failures (ADR 0082).
  `pr/closeout-review{,-exec,-git,.test}.mjs` route
  `pnpm agent:closeout-review:test`.
  `repo-health/check-guardrail-prose{,.test}.mjs` and
  `repo-health/guardrail-prose.json` route the guardrail suite. `ci.yml`,
  quick-commands, and the manifest pin it (ADR 0073).
- **Gate runtime pins.** Before `cd`, `agent-quality-gate.sh` resolves
  `gate/run-handles.sh`, coordinator files,
  `docs/docs-navigation-eval-helpers.mjs`, and `gate/lockfile-scope.mjs` from
  `$script_source_dir`; tests hash them from `$repo_root`. Move these paths with
  signatures, fixtures, literals, and `.coderabbit.yaml` review scope together
  (ADRs 0064 and 0076).
- **Gate mapping pins.** Signatures and Turbo inputs pin
  `gate/routing-table/**`, `gate/mapping*`, the autoreview core, and sealed
  policy. Runtime hashes use `$script_source_dir`; suites use `$repo_root`.
  Core and inventory edits route autoreview and parity suites.
  Setup, marker, SessionEnd, and package-policy edits route focused setup
  suite. Missing pins freeze the stamp (ADRs 0069 and 0079). Three exact pins:
  `.dependency-cruiser.cjs` and root `package.json` both name
  `gate/mapping/engine.test.mjs` (scanned roots);
  `gate/mapping/post-passes.mjs` schedules `code-health:deps` itself.
- **Review-eval pins.** The runbook tracks `scripts/review/run-eval*.sh`,
  `install-review-eval-launchd*`, `review-eval-*publication*`, and the
  sealed cell modules in `ORCHESTRATOR_FILES`. Its file table and ADR 0083
  pin `scripts/review/review-eval-experiment*.mjs`.
- **Navigation-eval pin.** `forbidden_sources` in
  `docs/evals/documentation-navigation-fixtures.json` names its source.
- **Verification evidence.** `.gitattributes` pins
  `scripts/docs/check-verification-redesign-evidence*.mjs`.
- **Sentry suite manifest.** `scripts/sentry/gate/sentry-suite-manifest.json`
  enforces two-way path equality with `findSentrySuites()`; moves fail closed.
  `sentry/fixture-scan-canary.test.mjs` re-pins four (ADR 0068).
- **Workflow pins.** Workflows pin `scripts/`. Terraform uses
  `terraform.stacks.json` `workflowAdmissionPatterns`.
  `check-ci-contract{,.test}.mjs` pins CI.
  `check-no-skip-audit{,.test}.mjs` pins admission, SHAs, cache, skips, protected
  drift, focused contracts, and the retained workflow graph. Moves update
  ADR 0064, routing, globs, and pins.
- **Terraform stack registry.** `terraform.stacks.json` `changedPathPatterns`
  pins exact `scripts/` paths per stack. The broad workflow admission boundary
  covers the directory; `pnpm tf:test` enforces subsumption.
- **Trusted-validator probes.** `pr-description.yml` resolves the validator at
  the PR base tip. After a move, keep dual probes until the new path reaches
  the base (issue 1904; ADR 0064).
- **PR validation boundary pins.** Move
  `workflows/check-pr-validation-boundary{,.test}.mjs` with `ci.yml` and
  `trunk.yml`. ADR 0078 defines the boundary.
- **Production identity pins.** In `production-infra-identity-contract/`, align
  `workflow-inventory.mjs`, `workflow.test.mjs`,
  `dependabot-auto-merge.test.mjs`, and `index.test.mjs` with their
  boundary import. The inventory pins audited paths.
- **External console pins.** Codex Cloud pins
  `bootstrap/codex-cloud-{setup,maintenance}.sh`; Claude Code web pins
  `bootstrap/claude-code-web-setup.sh` through `.claude/hooks/session-start.sh`.
  Moves need operator updates.
- **Reviewed-artifact byte pins.** `.gitattributes` pins the Upstash launcher
  EOL; `UPSTASH_MCP_LAUNCHER_SHA256` hashes it. Moves change both. See
  [`docs/notes/upstash-mcp-operator.md`](../docs/notes/upstash-mcp-operator.md).

**List every new `scripts/` path pin here.**

## Sweep Checklist for a Move

Apply every item in
[ADR 0064's move checklist](../docs/adr/0064-scripts-module-directories.md#sweep-checklist-for-a-move)
in the same PR.

## Operating Rules

- Shell entrypoints use `set -euo pipefail`, or `set -Eeuo pipefail` when an
  `ERR` trap needs inheritance. Source-only helpers leave shell options to their
  caller.
- Parse JSON with Node, jq, or structured tooling, never grep or sed.
- Compact/watch scripts keep machine state and cadence metadata separate from
  display strings. Gate emissions on stable fields, not volatile counters,
  block heights, or progress lines.
- Wrappers that deploy local checkout state source `scripts/lib/deploy-guard.sh`
  before mutation. `deploy-indexer:promote` acts on a registered remote
  deployment; use it through the `deploy-indexer` skill after its clean-tree
  preflight, verification, and production approval.
- Only `deploy-indexer.sh`'s isolated `envio` trigger-ref push may use
  `--no-verify`. Never use it in developer Git commands.
- New deploy scripts print target, commit, and rollback/verification around
  mutation.
- Run `pnpm lint:scripts` for new Node root scripts and `bash -n` for new shell
  scripts. Add focused tests beyond lint and syntax. Add required CI wiring if
  no fixed job owns them.
- No ESLint `max-lines` reaches this tree. The file-size watchlist reports it
  instead — tests aside, three trust-root files exempt:
  [ADR 0065](../docs/adr/0065-scripts-file-size-watchlist-scope.md).
- `pnpm tf plan/apply platform` owns one private saved plan. Never accept a
  caller plan path, or print, upload, or cache either plan form. Mechanism and
  deploy-only bootstrap exception:
  [ADR 0061](../docs/adr/0061-exact-plan-guard-for-manual-platform-applies.md).
- `pnpm tf:test` enforces the deployment source-staging contract. Never add a
  deploy callsite, an indirect or dynamic deploy form, or a CLI service-account
  override; keep inert examples in `scripts/deploy-staging-contract.test.mjs`.
  [ADR 0053](../docs/adr/0053-explicit-deployment-source-staging.md) owns the
  contract, callsites, and proof limits.

## Verification

Apply [PR operating card step 3](../docs/notes/pr-operating-card.md) to each
changed root tool: `bash -n <changed-shell-script>`, `pnpm lint:scripts`, and
its focused test. Required CI owns the legacy gate self-test. Deploy wrappers
also run
`node scripts/check-deploy-root-anchors.test.mjs`. After a move, run
`pnpm agent:context-check` and `pnpm docs:index --check`.
