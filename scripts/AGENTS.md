---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-31
doc_type: agent-instructions
scope: scripts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Scripts

Read the relevant [ADR](../docs/adr/README.md) before changing script behavior.

## Scope

`scripts/` holds deploy, maintenance, gate, and code-health tools.

## Layout

[ADR 0064](../docs/adr/0064-scripts-module-directories.md) governs these
subdirectories.

- `deploy/`: deploy wrappers and Node helpers
- `workflows/`: Actions workflow support
- `bootstrap/`: container and hosted-session setup
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
Eight docs and `.config/wt.toml` pin flat `setup.sh`.
ADR 0064 keeps `redrive-onchain-deadletter.{mjs,test.mjs}` flat in
`alerts/infra/` for lint.

Shared `lib/` cores: `hcl.mjs` (Terraform HCL), `workflow-yaml.mjs` (Actions/shell),
`pnpm-override-selector.mjs` (pnpm overrides), and `gh-issue-lifecycle.mjs`
(shared issue/label mechanics; doc schedulers read it). Projection keeps
`agent-ready` on create and all lifecycle labels on closed repair. ADR 0064
lists readers.
`peg-policy-digest.mjs` defines the peg version-digest contract for both
validators. Inventories, pinned hashes, and identities stay with their domain.

## Why Files Stay Flat

Move 15 path-pin classes with files except `agent-autoreview.sh`
feedback-runtime pins.

- **Autoreview runtime pins.** `agent-autoreview.sh` pins runtime, sealed
  `agent-autoreview-secret-suppressions.json` (ADR 0079), and optional
  `pr-feedback-state-claude.mjs` and `pr-ready-state-review-signals.mjs`.
  Feedback uses `origin/main`. Use ADR 0064's three-merge move sequence.
- **Gate routing pins.** Stub tests require
  `$script_source_dir == $repo_root/scripts`.
  `pr/review-process-metrics{,-{core,finding-classifier,legacy,markdown,report,signals,timeline},.test}.mjs`
  and
  `pr/fixtures/review-process-metrics-coderabbit.json` use exact routes.
  `bootstrap/codex-cloud-setup.{sh,test.sh}` pair for offline tests.
  `sentry/autofix/sentry-autofix-refused-inventory.mjs` routes
  `pnpm sentry:autofix:{run-record,finalize}:test`. Exact
  `sentry/triage/sentry-triage-project-route.mjs` routes
  `pnpm sentry:project:test`.
  `deploy/deploy-indexer-verify{,-analysis}{,.test}.mjs` and
  `deploy/deploy-indexer-verify-status-identity.mjs` use one any-depth arm;
  both verifier tests run. Exact `pr/agent-issue-board{,.test}.mjs` and
  `pr/issue-board-{backfill,cli,commands,lock,ownership,projects,release,state,sync,sync-lock,transactions,transport}.mjs`
  route to `pnpm issue:board:test`; CI runs it after failures. ADR 0082 owns
  confinement. Exact
  `repo-health/check-guardrail-prose{,.test}.mjs` and
  `repo-health/guardrail-prose.json` route to the guardrail suite. `ci.yml`,
  quick-commands, and the manifest pin it as ADR 0073 specifies.
  `pr/merge-pr*`, both PR-state helpers, and `agent-autoreview.sh` (Codex
  markers) route `pnpm pr:merge:test`.
- **Gate runtime pins.** Before `cd`, `agent-quality-gate.sh` resolves
  `gate/run-handles.sh`, coordinator files,
  `docs/docs-navigation-eval-helpers.mjs`, and `gate/lockfile-scope.mjs` from
  `$script_source_dir`; tests hash them from `$repo_root`. Move paths with their
  routes, signatures, fixtures, and literals (ADRs 0064 and 0076).
- **Gate mapping pins.** The signature and Turbo inputs pin
  `gate/routing-table/**`, `gate/mapping*`, the autoreview core, and its sealed
  policy. Runtime hashes use `$script_source_dir`; suites use `$repo_root`.
  Core edits route both suites; policy edits route autoreview. Missing pins
  freeze the stamp (ADRs 0069 and 0079).
- **Review-eval pins.** `review/run-eval-source-snapshot.sh` joins the
  four-source set in `docs/evals/review-skill.md`; update every listed consumer
  together.
- **Navigation-eval self-pin.** `forbidden_sources` in
  `docs/evals/documentation-navigation-fixtures.json` names its implementation.
- **Verification evidence.** Move
  `scripts/docs/check-verification-redesign-evidence*.mjs` with the
  `.gitattributes` patch rule.
- **Sentry suite manifest.** `scripts/sentry/gate/sentry-suite-manifest.json`
  keys are exact repo-relative paths, reconciled against `findSentrySuites()`
  by set equality both ways. A moved or renamed suite fails the gate closed.
  `sentry/fixture-scan-canary.test.mjs` re-pins four; ADR 0068 has the policy.
- **Workflow pins.** Workflows and `sentry-triage-agent.yml` pin `scripts/`.
  Terraform filters use `terraform.stacks.json` `workflowAdmissionPatterns`.
  `check-ci-contract{,.test}.mjs` pins jobs, filters,
  commands, and the aggregate. Moves update ADR 0064, routing equality,
  glob rules, and review-eval pins.
- **Terraform stack registry.** `terraform.stacks.json` `changedPathPatterns`
  pins exact `scripts/` paths per stack. The broad workflow admission boundary
  covers the directory; `pnpm tf:test` enforces subsumption.
- **Trusted-validator probes.** `pr-description.yml` resolves the validator at
  the PR base-branch tip, not a PR snapshot. After a move, keep dual probes
  until the new path reaches the base (issue 1904; ADR 0064).
- **PR validation boundary pins.** Move
  `workflows/check-pr-validation-boundary{,.test}.mjs` with `ci.yml` and
  `trunk.yml`. ADR 0078 defines the boundary.
- **Production infrastructure identity pins.** Under
  `production-infra-identity-contract/`, keep
  `workflow-inventory.mjs`, `workflow.test.mjs`,
  `dependabot-auto-merge.test.mjs`, and `index.test.mjs` aligned with the
  boundary import. `workflow-inventory.mjs` pins audited workflow script paths.
- **External console pins.** Codex Cloud pins
  `bootstrap/codex-cloud-{setup,maintenance}.sh`; Claude Code web pins
  `bootstrap/claude-code-web-setup.sh` through `.claude/hooks/session-start.sh`.
  Moves need external operator updates.
- **Reviewed-artifact byte pins.** `.gitattributes` pins the Upstash launcher
  EOL and `UPSTASH_MCP_LAUNCHER_SHA256` hashes it. A move changes both. See
  [`docs/notes/upstash-mcp-operator.md`](../docs/notes/upstash-mcp-operator.md).

List new path pins here; unrecorded pins can break moves.

## Sweep Checklist for a Move

Apply [ADR 0064's move checklist](../docs/adr/0064-scripts-module-directories.md#sweep-checklist-for-a-move)
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
- Do not add `--no-verify` to normal Git commands. `deploy-indexer.sh` uses it
  only for `envio` trigger-ref pushes, which intentionally skip redundant
  pre-push hooks; never generalize it.
- New deploy scripts print target, commit, and rollback/verification around
  mutation.
- New Node root scripts need `pnpm lint:scripts` coverage; new shell scripts must
  pass `bash -n`. Add a focused command to `scripts/agent-quality-gate.sh` for
  behavior syntax and lint cannot verify.
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

Run `pnpm agent:quality-gate --run`; its mapping routes `bash -n`,
`pnpm lint:scripts`, and focused tests for what changed. Add
`pnpm agent:quality-gate:test` for gate routing changes,
`node scripts/check-deploy-root-anchors.test.mjs` for deploy wrappers, and
`pnpm agent:context-check` plus `pnpm docs:index` after a move.
