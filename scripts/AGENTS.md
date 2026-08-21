---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-23
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

| Directory       | Holds                                  |
| --------------- | -------------------------------------- |
| `deploy/`       | deploy wrappers and their Node helpers |
| `workflows/`    | scripts backing Actions workflow jobs  |
| `bootstrap/`    | container and hosted-session setup     |
| `context/`      | agent context, budget, doc catalog     |
| `docs/`         | audit planner, garden, navigation eval |
| `pr/`           | PR and issue state projections         |
| `supply-chain/` | lockfile, audit, pin, skew gates       |
| `mcp/`          | MCP broker, launcher, config rendering |
| `alerts/`       | alert-rule lint, peg-policy checks     |
| `repo-health/`  | code-health, file-size, lint wrappers  |
| `terraform/`    | movable Terraform guards and helpers   |
| `gate/`         | gate routing engine + helpers          |
| `sentry/`       | triage/autofix/gate/broker/ci-wiring   |

`lib/` and `production-infra-identity-contract/` predate the reorganization.
`setup.sh` stays flat because `.config/wt.toml` uses its exact Worktrunk
pre-start path and eight docs name it. `redrive-onchain-deadletter.{mjs,test.mjs}`
stays flat under `alerts/infra/` ownership; ADR 0064 gives the lint reason.

`lib/` holds cores more than one cluster reads. `hcl.mjs` (Terraform HCL
tokenizer and block extraction), `workflow-yaml.mjs` (Actions workflow and
shell-run parsing), `pnpm-override-selector.mjs` (pnpm override selectors), and
`gh-issue-lifecycle.mjs` (the `gh` runner, pagination guard, Documentation
Garden workflow authorization, label bootstrap, and issue-queue arbitration).
Cores stay outside domain directories; ADR 0064 records which clusters read
each. `peg-policy-digest.mjs` is the one definition of the peg version-digest
contract both peg validators check. Inventories, pinned hashes, and identities
stay with their domain.

## Why Files Stay Flat

`scripts/` has twelve path-pin classes. Move each pin with its file in the
same PR, except the `agent-autoreview.sh` feedback-runtime pins below.

- **Autoreview runtime materialization.** `agent-autoreview.sh` pins sibling
  runtime in Perl lists and `runtime_paths`; feedback helpers use `origin/main`.
  Move feedback paths in three merges: add copies and a dual-path fallback;
  repoint consumers; remove old paths and fallback when no pre-move wrapper
  remains (ADR 0064).
- **Gate routing pins.** The gate excludes stub-repo tests with
  `$script_source_dir == $repo_root/scripts`, and pairs
  `bootstrap/codex-cloud-setup.{sh,test.sh}` for offline tests. It routes
  `sentry/autofix/sentry-autofix-refused-inventory.mjs` alone to
  `pnpm sentry:autofix:run-record:test` and
  `pnpm sentry:autofix:finalize:test`. The exact
  `sentry/triage/sentry-triage-project-route.mjs` path routes to
  `pnpm sentry:project:test` with the projection family.
- **Gate runtime module pins.** Before `cd`, `agent-quality-gate.sh` loads
  `$script_source_dir/gate/run-handles.sh`; move it with its signature, self-test
  route, and missing-helper fixture. It also pins
  `docs/docs-navigation-eval-helpers.mjs` and `gate/lockfile-scope.mjs` to
  `$script_source_dir` in three literals; update every pin (ADR 0064).
- **Gate routing and mapping pins.** Every `gate/routing-table/*.mjs` and
  `gate/mapping*.mjs` appears in `implementation_signature()` and `turbo.json`;
  `gate/routing-parity.mjs` is signature-only, not a Turbo input. Runtime hashes
  use `$script_source_dir`; test and parity hashes use `$repo_root`. A missing
  pin freezes the stamp for routing code
  ([ADR 0069](../docs/adr/0069-gate-routing-table-as-data.md)).
- **Evaluation fixture forbidden lists.** `forbidden_sources` in
  `docs/evals/documentation-navigation-fixtures.json` names the navigation
  eval's own implementation.
- **Sentry suite manifest.** `scripts/sentry/gate/sentry-suite-manifest.json`
  keys are exact repo-relative paths, reconciled against `findSentrySuites()`
  by set equality both ways. A moved or renamed suite fails the gate closed.
  `sentry/fixture-scan-canary.test.mjs` re-pins four; ADR 0068 has the policy.
- **Enumerated workflow pins.** 22 of 32 files in
  `.github/workflows/` pin a `scripts/` path, and `sentry-triage-agent.yml`
  stages an exact copy list at runtime; three Terraform filters instead
  copy the broad `workflowAdmissionPatterns` boundary from
  `terraform.stacks.json`. A miss is silent — the job stops running while the
  required `ci` sentinel stays green. The enumeration, the `routing.test.mjs`
  equality contract, and when a module glob is the safer pin are in
  [ADR 0064](../docs/adr/0064-scripts-module-directories.md#sweep-checklist-for-a-move).
- **Terraform stack registry.** `terraform.stacks.json` `changedPathPatterns`
  pins exact `scripts/` paths per stack. The broad workflow admission boundary
  covers the directory; `pnpm tf:test` enforces subsumption.
- **Trusted-validator probes.** `pr-description.yml` runs the validator from the
  PR's base ref via the base branch **name**, so it resolves to that branch's
  tip, never a PR-time snapshot. One probe
  path is enough once the target path is live on the base branch (issue 1904);
  a move still needs a temporary dual probe for the commit that performs it.
  ADR 0064 has the failure mode.
- **Production infrastructure contract pins.**
  `production-infra-identity-contract/workflow-inventory.mjs` pins exact script
  paths for the workflows it audits.
- **External console pins.** The Codex Cloud console holds
  `bootstrap/codex-cloud-setup.sh` and
  `bootstrap/codex-cloud-maintenance.sh`; Claude Code web resolves
  `bootstrap/claude-code-web-setup.sh` through `.claude/hooks/session-start.sh`.
  A move needs an operator edit because repo grep cannot reach that console.
- **Reviewed-artifact byte pins.** `.gitattributes` pins the Upstash launcher
  EOL and `UPSTASH_MCP_LAUNCHER_SHA256` hashes it. A move changes both. See
  [`docs/notes/upstash-mcp-operator.md`](../docs/notes/upstash-mcp-operator.md).

**List each new `scripts/` path pin here.** An unrecorded pin breaks silently on
the next move.

## Sweep Checklist for a Move

Apply every item in
[ADR 0064's eleven-surface move checklist](../docs/adr/0064-scripts-module-directories.md#sweep-checklist-for-a-move)
in the same PR.

## Operating Rules

- Shell entrypoints use `set -euo pipefail`, or `set -Eeuo pipefail` when an
  `ERR` trap needs inheritance. Source-only helpers leave shell options to their
  caller.
- Parse JSON with Node, jq, or structured tooling, never grep or sed.
- Compact/watch scripts must keep machine state and cadence metadata separate
  from display strings. Gate emissions on stable fields, not volatile counters,
  block heights, or progress lines.
- Wrappers that deploy local checkout state source `scripts/lib/deploy-guard.sh`
  before mutation. `deploy-indexer:promote` acts on a registered remote
  deployment; use it through the `deploy-indexer` skill after its clean-tree
  preflight, verification, and production approval.
- Do not add `--no-verify` to normal Git commands. `deploy-indexer.sh` uses it
  only for `envio` trigger-ref pushes, which intentionally skip redundant
  pre-push hooks; never generalize it.
- New deploy scripts must print target, commit, and rollback or verification command around mutation.
- New Node root scripts need `pnpm lint:scripts` coverage; new shell scripts must
  pass `bash -n`. Add a focused command to `scripts/agent-quality-gate.sh` for
  behavior syntax and lint checks cannot verify.
- No ESLint `max-lines` reaches this tree. The file-size watchlist reports it
  instead — tests aside, three trust-root files exempt:
  [ADR 0065](../docs/adr/0065-scripts-file-size-watchlist-scope.md).
- `pnpm tf plan/apply platform` owns one private saved plan. Never accept a
  caller plan path, or print, upload, or cache either plan form. The wrapper
  mechanism and its deploy-only bootstrap exception are in
  [ADR 0061](../docs/adr/0061-exact-plan-guard-for-manual-platform-applies.md).
- `pnpm tf:test` enforces the deployment source-staging contract. Never add a
  deploy callsite, an indirect or dynamic deploy form, or a CLI service-account
  override; keep inert examples in `scripts/deploy-staging-contract.test.mjs`.
  [ADR 0053](../docs/adr/0053-explicit-deployment-source-staging.md) owns the
  contract, the allowed callsites, and its proof limits.

## Verification

Run `pnpm agent:quality-gate --run`; its mapping routes `bash -n`,
`pnpm lint:scripts`, and focused tests for what changed. Add
`pnpm agent:quality-gate:test` for gate routing changes,
`node scripts/check-deploy-root-anchors.test.mjs` for deploy wrappers, and
`pnpm agent:context-check` plus `pnpm docs:index` after a move.
