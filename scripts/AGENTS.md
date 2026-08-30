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

`scripts/` has 15 path-pin classes. ADR 0064 owns the full move inventory.
The gate mechanics runbook owns the exact
[autoreview, routing, runtime, and mapping pins](../docs/notes/agent-quality-gate-mechanics.md#script-path-pins).
Move every pin with its file. Use its staged move procedure for feedback
runtime paths read from `origin/main`.

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
- **Controlled lifecycle boundary pins.** Platform plan, ruleset drift,
  Actions-secret, and broker paths are cross-tree pins. ADR 0080 and its
  runbook own their exact files, tests, consumers, and fixed host paths.
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
- Controlled lifecycle and GitHub App code follows
  [ADR 0080](../docs/adr/0080-controlled-main-lifecycle-boundary.md) and its
  [runbook](../docs/notes/local-agent-github-app-credential.md). Preserve every
  source, recovery, broker, host, redaction, and custody control they own.
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
