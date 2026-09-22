---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-09-04
doc_type: agent-instructions
scope: scripts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Scripts

Read the owning [ADR](../docs/adr/README.md) before edits.

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

## Path Pins

Move each pin class together.

- **Retained process-marker helper.** `lib/mapped-command-process-identity.mjs` has no caller since ADR 0106 deleted the Sentry broker, but `scripts/docs/check-verification-redesign-evidence.mjs` pins its path by name. Keep the file and its tests; a move updates that pin.
- **Indexer invariant ownership.** `workflows/indexer-handler-invariant-{contract,families}.mjs` supplies the retained checklist contract; root indexer contract tests and CI filters pin these paths.
- **Review-eval pins.** Runbook: `run-eval*`,
  `install-review-eval-launchd*`, `review-eval-*publication*`,
  `ORCHESTRATOR_FILES` cells, `SCORING_MODULES` and
  `validationModuleLineLimits` scorers (incl. `review-eval-schedule-issue.mjs`),
  `review-eval-experiment*.mjs`. The sealed set is ten files in a fixed order:
  `run-eval{,-source-snapshot,-lifecycle,-runtime,-matrix,-plan,-publish,-cell}.sh`
  plus `review-eval-{cell-writer,stream}.mjs`. Adding or moving one updates
  `ORCHESTRATOR_FILES`, the four lists in `run-eval-source-snapshot.sh`, the
  bootstrap trap in `run-eval.sh`, the verify list in `run-eval-lifecycle.sh`
  and the digest in `review-eval.test.mjs`. ADR 0108 states the rule.
- **Navigation-eval pin.** `forbidden_sources` in
  `docs/evals/documentation-navigation-fixtures.json` names its source.
- **Verification evidence.** `.gitattributes` pins
  `scripts/docs/check-verification-redesign-evidence*.mjs`.
- **Sentry bridge contract.** `alerts/sentry-bridge-contract.test.mjs` covers the
  alert-delivery bridge, not the retired pipeline; `tf-stacks.test.mjs` imports
  it by path.
- **Babysit pin.** Move `pr/pr-stack-ready-state*.mjs` with
  `.claude/babysit-pr.sh`.
- `pr:ready-state:test`: `pr/pr-ready-state*.mjs` and
  `pr/pr-stack-{ready-state,recover}*.mjs`; `pr:feedback-state:test`:
  `pr/pr-feedback-state*.mjs`.
- **Workflow pins.** `check-ci-contract{,.test}.mjs` pins CI (ADR 0102).
  `check-no-skip-audit{,.test}.mjs` pins admission, SHAs, caches, skips,
  `repo-health/dependency-cruiser-root-contract.test.mjs`, and the retained
  graph. Moves update ADR 0064 and all pins.
  `ci.yml` pins `report-ci-reliability{,.test}.mjs` (ADR 0100).
- **Terraform stack registry.** `terraform.stacks.json` `changedPathPatterns`
  pins exact `scripts/` paths per stack. Admission lists six `scripts/`
  entries, not the tree; `pnpm tf:test` enforces subsumption.
- **Trusted-validator probes.** `pr-description.yml` resolves the validator at
  the PR base tip. After a move, keep dual probes until the new path reaches
  the base (issue 1904; ADR 0064).
- **PR validation boundary pins.** Move
  `workflows/check-pr-validation-boundary{,.test}.mjs` and its credential
  helper `workflows/workflow-credentials{,.test}.mjs` with `ci.yml` and
  `trunk.yml`. ADR 0078 defines it.
- **Production identity pins.** In `production-infra-identity-contract/`, align
  `workflow-inventory.mjs`, `workflow.test.mjs`,
  `dependabot-auto-merge.test.mjs`, and `index.test.mjs` with their
  boundary import. The inventory pins audited paths.
- **External console pins.** Codex Cloud pins
  `bootstrap/codex-cloud-{setup,maintenance}.sh`; Claude Code web pins
  `bootstrap/claude-code-web-setup.sh` through `.claude/hooks/session-start.sh`.
  Moves need operator updates.
- **Hosted gh capability pin.** `codex-cloud-setup.sh` sources
  `bootstrap/codex-cloud-github-cli.sh`, and `agent-setup-contract.test.sh`
  names that path. A move updates both.
- **Reviewed-artifact byte pins.** `.gitattributes` pins the Upstash launcher
  EOL; `UPSTASH_MCP_LAUNCHER_SHA256` hashes it. Moves change both. See
  [`docs/notes/upstash-mcp-operator.md`](../docs/notes/upstash-mcp-operator.md).

- **Shell size gate pins.** `repo-health/check-shell-size{,.test}.mjs` and
  `repo-health/shell-size-baseline.txt` move together; the checker reads the
  baseline beside it, and `trunk.yml` runs the checker and its test by path.

**List new `scripts/` path pins here.**

## Sweep Checklist for a Move

Apply
[ADR 0064's move checklist](../docs/adr/0064-scripts-module-directories.md#sweep-checklist-for-a-move)
in one PR.

## Operating Rules

- Shell entrypoints use `set -euo pipefail`, or `set -Eeuo pipefail` when an
  `ERR` trap needs inheritance. Source-only helpers leave options to their
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
  `--no-verify`. Never use it in developer commands.
- New deploy scripts print target, commit, and rollback/verification around
  mutation.
- Run `pnpm lint:scripts` for new Node root scripts and `bash -n` for new shell
  scripts. Add focused tests beyond lint and syntax. Add required CI wiring if
  unowned.
- The file-size watchlist replaces ESLint `max-lines` for JavaScript here,
  excluding tests. It reports and never blocks. No exemptions remain:
  [ADR 0065](../docs/adr/0065-scripts-file-size-watchlist-scope.md).
- Shell size is enforced repository-wide, tests included: 500 lines per `*.sh`
  file, 50 per shell function, by `pnpm check:shell` and by required CI
  ([ADR 0107](../docs/adr/0107-enforced-shell-size-limits.md)).
  `repo-health/shell-size-baseline.txt` exempts what predates the limits and
  documents its own row format. A row is an upper bound keyed by path and
  name, so renaming or moving an exempt function drops its exemption; split it
  in that change. `SHELL_SIZE_BASE=<resolved-pr-base>` adds the ratchet: no new
  row, no higher count. `check-shell-size.mjs` is a byte-identical copy from
  `mento-protocol/agents`; change it there, then copy it. Never edit the copy.
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
its focused test. A changed `*.sh` file also runs `pnpm check:shell`. The legacy diagnostic and its self-tests are retired. Deploy wrappers also run
`node scripts/check-deploy-root-anchors.test.mjs`. After a move, run
`pnpm agent:context-check` and `pnpm docs:index --check`.
