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

- [x] **PR 2**: Per-package ESLint code-health budgets shipped at `error` severity with a diff-aware baseline (`eslint-baseline.json` per package, gated by `scripts/eslint-baseline-diff.mjs`). Rules: `complexity`, `max-lines-per-function`, `max-depth`, `max-params`, plus `eslint-plugin-sonarjs` (cognitive-complexity + 4 suspicious-pattern rules). Strictest on `shared-config`; loosest inside `indexer-envio/src/handlers/**`. Pre-existing baselines: shared-config 0, metrics-bridge 11, ui-dashboard 188, indexer-envio 63 entries. Line-proximity absorption (30 lines) handles refactors; CI merge-base check prevents hand-grown baselines. See `docs/pr-checklists/code-health.md`.
- [x] **PR 3**: Added `jscpd` duplication detection via `pnpm code-health:duplication` + a non-blocking CI job (`.github/workflows/code-health-duplication.yml`) that uploads the HTML+JSON report as an artifact. Tests, handlers, route entry pages, layouts, opengraph images, and pure type modules are excluded. Initial baseline: **218 clones** at min-tokens=50, min-lines=5 (across `shared-config`, `ui-dashboard` non-route code, `indexer-envio` non-handler code, `metrics-bridge`). The report is intended as an extract-helper-refactor backlog — non-blocking so PRs aren't gated on historical copy-paste; tighten thresholds or block specific paths in a follow-up.
- [x] **PR 4**: `indexer-envio` ESLint cleanup. `@eslint/js` + `typescript-eslint` recommended baseline was already enabled (the stale BACKLOG entry was wrong); the next strictness step was re-enabling the disabled `no-unsafe-*` rules. Done: rules re-enabled across `src/**`; `src/performance.ts` (Proxy-based instrumentation; `Reflect.get` returns `any` by design) gets its own narrow exception; one genuine `no-unsafe-return` in `aggregators.ts` fixed by adding type args to `new Map()` / `new Set()`. 0 errors / PR 2 complexity-budget baseline preserved.
- [x] **PR 6 (baseline cleanup)**: Fixed 4 `sonarjs/no-collapsible-if` violations in `protocolFeeSnapshot.ts`, `volume-over-time-chart.tsx`, `address-labels-shared.ts`, and `revenue.ts`. The rule was already at `error` severity in all packages from PR 2 (diff-aware baseline gates new violations as errors); these were carried as baseline entries. Pruning them shrinks the baseline. The merging-of-nested-ifs also bumped sibling `complexity` / `sonarjs/cognitive-complexity` / `max-lines-per-function` scores upward (collapsed control flow adds cognitive load per sonarjs's metric), so the same PR extracts helpers from the four affected functions (`upgradeEntry`, `buildDailyVolumeSeries`, `buildDailyFeeSeries`, `mergeFeeSnapshot`) to bring those scores back under budget. Net baseline shrink: ui-dashboard 188 → 179 (-9), indexer-envio 63 → 59 (-4). Future ratchets continue here: keep shrinking each package's `eslint-baseline.json` PR-by-PR until empty.
- [x] **PR 1 (this branch)**: Added `knip` to `shared-config`, `ui-dashboard`, `metrics-bridge` (was already in `indexer-envio`). Each package runs strict `knip` in CI; files/deps blocking, exports/types as warn-only.
- [x] **PR 1**: Added `dependency-cruiser` with cross-package boundary rules (blocking) and a no-circular rule (warn-only baseline; promotes to error after the known indexer cycle is broken — see below).
- [x] **PR 1**: Added `scripts/code-health-history.mjs` + `pnpm code-health:history`. First baseline committed to `reports/code-health-history.md`.
- [ ] Promote dashboard + indexer mutation gates from advisory (`break: null`) to PR-blocking once the same "runtime + noise sane in CI" + survivor-triage evidence we collected for bridge in PR 436 is captured for each. Pattern: trigger the workflow manually on `main`, confirm runtime ≤ 1 min, triage every survivor (add tests for real gaps; classify equivalents in `docs/mutation-testing.md`), then flip `break` to the post-triage rounded floor with a 2-pt margin, and add a new always-runs job (with inline `filter` + `decide` + `continue-on-error` shape) for that package — NOT a workflow-level `pull_request.paths` filter, since required-status checks must keep the trigger unfiltered (see `AGENTS.md`).
- [ ] Document which signals are blocking vs advisory in `AGENTS.md` and the PR handoff checklist once the tool mix is validated. _Partially done in PR 1 (`AGENTS.md` "Code health budgets" + `docs/pr-checklists/code-health.md`); revisit when later tiers land._
- [ ] **PR 1 follow-up**: Break the circular import between `indexer-envio/src/pool.ts` and `indexer-envio/src/deviationBreach.ts` (probably by extracting `recordBreachTransition`). Once clean, promote `no-circular` from `warn` → `error` in `.dependency-cruiser.cjs`.
- [x] ~~**PR 1 follow-up**: Remove the temporary `knip`, `oxlint`, `@oxlint/*` entries from `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` block~~ Done in the round-8 commit; the pinned versions (knip@6.12.2 from 2026-05-09, oxlint@1.64.0 from 2026-05-11) have aged past the 3-day gate, so future bumps now go through the standard supply-chain wait again.

Acceptance: the first implementation PR adds at least one blocking low-noise
quality gate and one advisory CodeScene-like report, records baseline findings,
and avoids adding another dashboard nobody reads.

### Package-Manager Supply-Chain Hardening Review

Why: the TanStack npm compromise shows that provenance and trusted publishing are
not enough when a release pipeline restores poisoned package-manager cache
contents. This repo already has useful defenses: minimumReleaseAge: 4320,
onlyBuiltDependencies, high+ pnpm audit, SHA-pinned CI install actions in the
shared install action, and a dedicated supply-chain workflow. The next step is a
targeted review, not a blind pnpm major bump.

- [ ] Compare current pnpm 10 protections with pnpm 11 security features and
      migration risk for this monorepo.
- [ ] Audit GitHub workflows for pull_request_target, writable token
      permissions, package-manager caches restored before untrusted code runs,
      and unpinned third-party actions; include .github/actions/pnpm-install
      and .github/workflows/supply-chain.yml.
- [ ] Decide whether minimumReleaseAge, minimumReleaseAgeExclude,
      onlyBuiltDependencies, and ignoredBuiltDependencies need tighter docs,
      tests, or policy checks.
- [ ] Evaluate whether an external package firewall or advisory service
      (Socket, Snyk, or equivalent) adds real signal beyond current pnpm audit
      without turning every lockfile refresh into noise.
- [ ] Produce a short recommendation PR: either implement the low-noise hardening
      directly, or document why the existing controls are sufficient for now.

Acceptance: any implementation must preserve CI stability, keep frozen-lockfile
installs fast, and include a rollback path. Reject pnpm 11 or third-party
scanners if the only benefit is theoretical.

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

- [x] ~~**Enable `tseslint.configs.recommended` on `indexer-envio`.**~~ Done as part of PR 4 (the preset had already been re-added by an earlier change; PR 4 took the strictness one step further by re-enabling `no-unsafe-*`).
- [ ] Split `ui-dashboard/src/components/global-pools-table.tsx`'s `GlobalPoolsTable` component to remove the scoped `max-lines-per-function` disable added while fixing the Clawpatch health-badge a11y finding.
- [ ] Extract the row renderer in `ui-dashboard/src/components/global-pools-table.tsx` to remove the scoped `max-lines-per-function` disable on `sortedEntries.map(...)`.
- [ ] Split `ui-dashboard/src/components/oracle-chart.tsx`'s `OracleChart` Plotly assembly to remove the scoped `max-lines-per-function` disable added while fixing non-finite deviation hover text.
- [ ] Split `indexer-envio/src/leaderboardSnapshots.ts`'s `applyLeaderboardSnapshots` rollup writer to remove the scoped `max-lines-per-function` disable added while fixing dropped-swap heartbeat flushing.

## Envio v3 Migration Follow-Ups

- [ ] **Pin `envio` to stable `^3.0.0` once released.** The migration currently targets `3.0.0-rc.0`; after the stable release, bump the dependency, regenerate code, and rerun codegen/typecheck/tests to catch API drift.
- [ ] **Validate the Envio v3 backfill speedup against production sync time.** Baseline before the migration was roughly 15-40 minutes per push. After deploy, compare wall-clock from indexer deploy to caught-up sync and decide whether the medium-tier cache upgrade can remain deferred.
