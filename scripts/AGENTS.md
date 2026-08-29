---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-30
doc_type: agent-instructions
scope: scripts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Scripts

Read the relevant [ADR](../docs/adr/README.md) before changing script behavior.

## Scope

`scripts/` holds deploy wrappers, agent quality gates, code-health checks, and
maintenance utilities.

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
- `github/`: local GitHub App host broker, agent client, and credential tests

`lib/` and `production-infra-identity-contract/` predate the reorg.
`.config/wt.toml` and eight docs pin flat `setup.sh`.
`redrive-onchain-deadletter.{mjs,test.mjs}` stays flat under
`alerts/infra/`; ADR 0064 gives the lint reason.

`lib/` holds shared HCL, workflow, pnpm-override, and GitHub issue cores. ADR
0064 lists their readers. `peg-policy-digest.mjs` defines the shared peg digest.
Inventories, hashes, and identities stay with their domain.

## Why Files Stay Flat

`scripts/` has 15 path-pin classes. Move each pin with its file, except the
`agent-autoreview.sh` feedback-runtime pins.

- **Autoreview runtime pins.** `agent-autoreview.sh` pins runtime,
  sealed `agent-autoreview-secret-suppressions.json` (ADR 0079), and optional
  `pr-feedback-state-claude.mjs` and
  `pr-ready-state-review-signals.mjs`; feedback uses `origin/main`. Use ADR
  0064's three-merge sequence for moves.
- **Gate routing pins.** The gate excludes stub-repo tests with
  `$script_source_dir == $repo_root/scripts`, and pairs
  `bootstrap/codex-cloud-setup.{sh,test.sh}` for offline tests. It routes
  `sentry/autofix/sentry-autofix-refused-inventory.mjs` alone to
  `pnpm sentry:autofix:run-record:test` and
  `pnpm sentry:autofix:finalize:test`. Exact
  `sentry/triage/sentry-triage-project-route.mjs` runs
  `pnpm sentry:project:test` in the projection arm.
  `deploy/deploy-indexer-verify{,-analysis}{,.test}.mjs` and
  `deploy/deploy-indexer-verify-status-identity.mjs` use one any-depth arm;
  both verifier tests run. The exact `pr/agent-issue-board{,.test}.mjs` and
  `pr/issue-board-{backfill,cli,commands,projects,state,sync,transport}.mjs` set
  routes to `pnpm issue:board:test`. Exact
  `repo-health/check-guardrail-prose{,.test}.mjs` and
  `repo-health/guardrail-prose.json` route to the guardrail suite. `ci.yml` pins
  both paths in two jobs, quick-commands names the checker, and the manifest's
  keys pin `AGENTS.md`, `CLAUDE.md` and the operating card. ADR 0073 has it.
  `pr/merge-pr*`, both PR-state helpers, and `agent-autoreview.sh` (Codex
  markers) route `pnpm pr:merge:test`.
- **Gate runtime pins.** Before `cd`, `agent-quality-gate.sh` resolves
  `gate/run-handles.sh`, coordinator files,
  `docs/docs-navigation-eval-helpers.mjs`, and `gate/lockfile-scope.mjs` from
  `$script_source_dir`; tests hash them from `$repo_root`. Move each path with
  its routes, signatures, fixtures, and literals (ADRs 0064 and
  0076).
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
- **Workflow pins.** `.github/workflows/` and `sentry-triage-agent.yml` pin
  `scripts/` paths. Three Terraform filters use `workflowAdmissionPatterns`
  from `terraform.stacks.json`. Update the ADR 0064 inventory, routing equality,
  glob rules, and review-eval pins when a path moves.
- **Terraform stack registry.** `terraform.stacks.json` `changedPathPatterns`
  pins exact `scripts/` paths per stack. The broad workflow admission boundary
  covers the directory; `pnpm tf:test` enforces subsumption.
- **Human boundary pins.** Platform plans, ruleset drift, and the local App
  broker are pinned across Terraform, workflows,
  gate routes, package scripts, CI, and operator docs. Move each implementation
  with its test and every consumer. ADR 0078 and its credential runbook own the
  exact files and fixed host install paths.
- **Trusted-validator probes.** `pr-description.yml` runs the validator from the
  PR base-branch tip, not a PR snapshot. After a move, keep dual probes
  until the new path reaches the base (issue 1904; ADR 0064).
- **PR validation boundary pins.** Move
  `workflows/check-pr-validation-boundary{,.test}.mjs` together. Keep its
  `ci.yml` and `trunk.yml` calls aligned. ADR 0078 defines the boundary.
- **Production infrastructure contract pins.**
  `production-infra-identity-contract/workflow-inventory.mjs` pins exact script
  paths for the workflows it audits.
- **External console pins.** Codex Cloud pins
  `bootstrap/codex-cloud-{setup,maintenance}.sh`; Claude Code web pins
  `bootstrap/claude-code-web-setup.sh` through `.claude/hooks/session-start.sh`.
  Moves need operator updates outside repo grep.
- **Reviewed-artifact byte pins.** `.gitattributes` pins the Upstash launcher
  EOL and `UPSTASH_MCP_LAUNCHER_SHA256` hashes it. A move changes both. See
  [`docs/notes/upstash-mcp-operator.md`](../docs/notes/upstash-mcp-operator.md).

**List each new `scripts/` path pin here.** An unrecorded pin breaks silently on
the next move.

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
- Platform plan/apply owns its private plan and CLI configuration. Reject a
  caller plan, credential environment or CLI input, provider-runtime override,
  and unknown argument without echo. Never persist plan data. ADR 0061 owns the
  exact guard and deploy-only exception.
- ADR 0078 and its runbook own the App boundary. Keep the Team, ruleset ID,
  broker-scaffold gate, partial-recovery gate, and broker principal in source.
  Keep the scaffold gate false until the separate Phase 4 source approval. Keep
  the recovery gate false except during reviewed create/no-op reconciliation.
  Parse and exercise the App RSA key only from the exact unindented HCL heredoc
  in the private tfvars copy. Reject JSON key assignments. Keep the PEM, JWT,
  and token outside agents and caller-controlled children. Preserve fixed root-owned execution, profiles,
  ambient-credential refusal, redaction, and no-token canaries. Agent input
  cannot select Workflow write. Follow the runbook for PEM custody, activation,
  and revoke-on-uncertain-custody.
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
