# Backlog

Active work only. Remove items from this file once they ship or are closed.
Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`,
or tests.

## Thoughtworks Technology Radar Follow-Ups

Source plan: `projects/mento-v3-monitoring/technology-radar-evaluation-plan.md`.
DORA metrics and Dev Containers remain intentionally excluded. CodeScene is covered
through the OSS quality-check backlog item below rather than by adopting the
commercial product.

### `mise` Toolchain Management Trial

Why: tool versions are currently spread across `.node-version`,
`packageManager`, Trunk runtimes, README/setup docs, and Terraform config.
`mise` is only worth adding if it reduces setup drift for fresh worktrees and
agent sessions.

- [ ] Inventory current version sources for Node, pnpm, Terraform, Python, Trunk, and setup scripts.
- [ ] Draft a minimal `mise.toml` for the tools where version drift actually hurts.
- [ ] Test fresh-shell setup: `mise install`, `pnpm install`, codegen, typecheck, and tests.
- [ ] Decide whether `mise` is canonical or optional convenience.
- [ ] If canonical, update docs and remove/clarify duplicate version declarations where safe.

Acceptance: setup becomes simpler than today. Reject if it just adds another
version source of truth.

### CodeScene-Equivalent OSS Quality Checks

Why: CodeScene's useful signal is not the proprietary score itself; it is the
combination of code-health smells, git-history hotspots, change coupling,
ownership risk, duplication, and weak-test detection. We already have strong
Trunk/CI coverage for syntax, formatting, security, supply chain, typechecking,
and tests. This item adds the missing CodeScene-like signals with open-source
tooling, staged so noisy metrics stay advisory until proven useful.

Current baseline:

- Trunk already gates `checkov`, `eslint`, `prettier`, `markdownlint`, `git-diff-check`, `trufflehog`, `osv-scanner`, `codespell`, `actionlint`, and `yamllint`.
- Pre-push hooks run `trunk fmt --all`, `trunk check --all`, package typechecks, and dashboard/bridge tests.
- CI runs package-scoped typecheck + coverage, Codecov upload, `pnpm audit --audit-level=high`, Terraform validation/fmt, and pinned GitHub Actions.
- ESLint already enforces unused imports and a 1,000-line hard file cap; UI also has React/Next/a11y rules.

Lightweight plan:

- [ ] Finish the known `indexer-envio` ESLint cleanup and enable the normal `@eslint/js` + `typescript-eslint` recommended baseline there.
- [x] **PR 2**: Added code-health ESLint budgets to all 4 packages as `warn`-only baseline: `complexity`, `max-lines-per-function`, `max-depth`, `max-params`, plus `eslint-plugin-sonarjs` (cognitive-complexity + 4 suspicious-pattern rules). Per-package thresholds; `src/handlers/**` in indexer-envio gets looser budgets. Baseline (zero errors): shared-config 0w, metrics-bridge 11w, ui-dashboard 191w, indexer-envio 63w; recorded in `reports/eslint-health-baseline.json`. PR 6 will ratchet to `error` after cleanup.
- [ ] Add `jscpd` for duplication detection, initially advisory or with conservative thresholds to avoid blocking on historical copy-paste.
- [x] **PR 1 (this branch)**: Added `knip` to `shared-config`, `ui-dashboard`, `metrics-bridge` (was already in `indexer-envio`). Each package runs strict `knip` in CI; files/deps blocking, exports/types as warn-only.
- [x] **PR 1**: Added `dependency-cruiser` with cross-package boundary rules (blocking) and a no-circular rule (warn-only baseline; promotes to error after the known indexer cycle is broken — see below).
- [x] **PR 1**: Added `scripts/code-health-history.mjs` + `pnpm code-health:history`. First baseline committed to `reports/code-health-history.md`.
- [ ] Reuse the targeted StrykerJS mutation-testing backlog item for the weak-test signal; only promote mutation checks to required CI after runtime/noise is proven sane.
- [ ] Document which signals are blocking vs advisory in `AGENTS.md` and the PR handoff checklist once the tool mix is validated. _Partially done in PR 1 (`AGENTS.md` "Code health budgets" + `docs/pr-checklists/code-health.md`); revisit when later tiers land._
- [ ] **PR 1 follow-up**: Break the circular import between `indexer-envio/src/pool.ts` and `indexer-envio/src/deviationBreach.ts` (probably by extracting `recordBreachTransition`). Once clean, promote `no-circular` from `warn` → `error` in `.dependency-cruiser.cjs`.
- [x] ~~**PR 1 follow-up**: Remove the temporary `knip`, `oxlint`, `@oxlint/*` entries from `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` block~~ Done in the round-8 commit; the pinned versions (knip@6.12.2 from 2026-05-09, oxlint@1.64.0 from 2026-05-11) have aged past the 3-day gate, so future bumps now go through the standard supply-chain wait again.

Acceptance: the first implementation PR adds at least one blocking low-noise
quality gate and one advisory CodeScene-like report, records baseline findings,
and avoids adding another dashboard nobody reads.

## File Size And Lint Hygiene

Current line counts for remaining watch files were refreshed on 2026-05-11.
`raw` is physical lines; `rough` approximates the ESLint `max-lines` count
after skipping blanks and comments. Refresh before starting a split.

| Raw | Rough | File                                            | Action                                                                                   |
| --: | ----: | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 749 |   542 | `indexer-envio/src/rpc/effects.ts`              | Watch; split if adding another effect family.                                            |
| 731 |   496 | `ui-dashboard/src/lib/network-fetcher/fetch.ts` | Watch; split fetch orchestration if another network-wide data source lands.              |
| 689 |   418 | `indexer-envio/src/handlers/sortedOracles.ts`   | Watch; split only with related oracle-handler work.                                      |
| 627 |   330 | `ui-dashboard/src/lib/leaderboard-hero.ts`      | Watch; split if hero KPI fallback or overlap logic grows again.                          |
| 608 |   464 | `ui-dashboard/src/lib/queries/leaderboard.ts`   | Watch; split leaderboard GraphQL fragments/queries if another leaderboard surface lands. |

- [ ] **Enable `tseslint.configs.recommended` on `indexer-envio`.** The current config deliberately omits the preset so the gating PR did not surface unrelated pre-existing nits. Flipping it on requires fixing `no-explicit-any`, `no-unused-vars`, and `no-require-imports` issues, adding `globals: globals.node`, and restoring the needed `@eslint/js` + `globals` devDeps.

## Envio v3 Migration Follow-Ups

- [ ] **Pin `envio` to stable `^3.0.0` once released.** The migration currently targets `3.0.0-rc.0`; after the stable release, bump the dependency, regenerate code, and rerun codegen/typecheck/tests to catch API drift.
- [ ] **Validate the Envio v3 backfill speedup against production sync time.** Baseline before the migration was roughly 15-40 minutes per push. After deploy, compare wall-clock from indexer deploy to caught-up sync and decide whether the medium-tier cache upgrade can remain deferred.
