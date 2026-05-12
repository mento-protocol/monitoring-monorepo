# Backlog

Active work only. Remove items from this file once they ship or are closed.
Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`,
or tests.

## Thoughtworks Technology Radar Follow-Ups

Source plan: `projects/mento-v3-monitoring/technology-radar-evaluation-plan.md`.
DORA metrics and Dev Containers remain intentionally excluded. CodeScene is covered
through the OSS quality-check backlog item below rather than by adopting the
commercial product.

### Browser-Based Component/Interaction Testing Pilot

Why: jsdom cannot prove real-browser behavior for Plotly, focus, hydration,
layout, and stateful UI interactions. This repo already requires interaction
tests for stateful data/UI changes; we need a small real-browser safety net
for the flows that matter.

- [ ] Spike Playwright Component Testing first; fall back to a minimal Playwright app-level harness if Next.js 16 / React 19 setup is too awkward.
- [ ] Use deterministic GraphQL fixtures/stubs; never hit live Hasura/Envio in tests.
- [ ] Cover 2-3 flows only: network switching, pool detail tab navigation, and degraded Hasura/query states.
- [ ] Add a `test:browser` script but do not make it required until runtime/flakiness is known.
- [ ] Record setup friction, runtime, and whether the tests catch behavior Vitest cannot.

Acceptance: headless run is stable, fixture-driven, and adds <2m if promoted
to a PR-required check.

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

### Targeted Mutation Testing Baseline

Why: normal coverage can tell us code executed while missing the invariant.
Monitoring logic has subtle failure modes where mutation testing can expose
weak assertions.

- [ ] Evaluate StrykerJS or equivalent against one narrow pure-logic target first, likely `ui-dashboard/src/lib/weekend.ts`.
- [ ] Keep mutation testing non-blocking and out of required CI until runtime/noise is proven.
- [ ] Configure the smallest useful scope; exclude generated files, tests, GraphQL barrels, ABIs, config-only files, and runtime-heavy RPC/dev-server paths.
- [ ] Classify surviving mutants as real test gaps, equivalent mutants/noise, or tool limitations.
- [ ] Add/improve tests only for real gaps, then record runtime and mutation score.
- [ ] Consider expanding next to pool ID/helpers and `metrics-bridge` rebalance probe/check logic.

Acceptance: finds at least one real assertion gap or gives high confidence on
a critical module with acceptable manual/nightly runtime.

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
- [ ] Add code-health-style ESLint budgets across packages: cyclomatic complexity, max nesting depth, max params, max lines per function, and optionally `eslint-plugin-sonarjs` for cognitive complexity / suspicious patterns.
- [ ] Add `jscpd` for duplication detection, initially advisory or with conservative thresholds to avoid blocking on historical copy-paste.
- [ ] Add `knip` for unused files, exports, and dependency hygiene; scope ignores explicitly for generated/Envio/test fixtures.
- [ ] Add `dependency-cruiser` to enforce package/layer boundaries and catch cycles or runtime-invalid imports between `shared-config`, `ui-dashboard`, `metrics-bridge`, and `indexer-envio`.
- [ ] Add a non-blocking CodeScene-lite history report script over `git log --numstat`: top churn × LOC hotspots, top change-coupled file pairs, files touched by many contributors, and weekly risk deltas. Keep this as an artifact/comment/report, not a merge gate.
- [ ] Reuse the targeted StrykerJS mutation-testing backlog item for the weak-test signal; only promote mutation checks to required CI after runtime/noise is proven sane.
- [ ] Document which signals are blocking vs advisory in `AGENTS.md` and the PR handoff checklist once the tool mix is validated.

Acceptance: the first implementation PR adds at least one blocking low-noise
quality gate and one advisory CodeScene-like report, records baseline findings,
and avoids adding another dashboard nobody reads.

## Virtual Pool Metrics

- [x] ~~**24h Volume tile for VPs.**~~ Done on `virtual-pools`: `BrokerExchangeDailySnapshot` now rolls up per-`chainId-exchangeId-day` Broker volume in the indexer, and the VirtualPool header reads that isolated daily rollup for the current UTC-day 24h volume tile with visible query-failure degradation. Requires a schema bump and full re-sync.

## Dashboard Data Correctness

- [x] ~~**Live `href` on the global "Sign in" link for cmd/ctrl/middle-click.**~~ Done in PR #389: `AuthStatus` now builds the rendered anchor from `useLiveLocation()`, a `useSyncExternalStore` wrapper around `pushState` / `replaceState` / `popstate`, so modified clicks and "open in new tab" use the same current callback URL as ordinary navigation. Component tests cover `replaceState` search-param updates, `pushState` path changes, `popstate` back navigation, and hydration correction.
- [x] ~~**Volume chart partial signal on the homepage.**~~ Done in PR #387: `buildDailyVolumeSeries` now returns `volumePartial`, `VolumeOverTimeChart` renders partial/unavailable v3 states explicitly, and tests cover skipped untrusted-decimal snapshots.
- [x] ~~**Pool detail tab panels gate on decimal trust state.**~~ Token-amount tabs now fail closed behind `TokenAmountTrustGate` until `POOL_THRESHOLDS_KNOWN_EXT` verifies token decimals; page tests cover untrusted decimals and trust-query failure without firing the tab-local reserves query.

## File Size And Lint Hygiene

Current line counts for remaining watch files were refreshed on 2026-05-11.
`raw` is physical lines; `rough` approximates the ESLint `max-lines` count
after skipping blanks and comments. Refresh before starting a split.

Completed on 2026-05-12 in PR #397:

- [x] `indexer-envio/src/pool.ts` split into health, self-heal, snapshot, source-priority, and context-type modules.
- [x] `indexer-envio/src/rpc/pool-state.ts` split into pool-state, oracle-state, and pool-fee modules.
- [x] `ui-dashboard/src/components/global-pools-table.tsx` split into sort, formatting, limit heatmap, and strategy badge modules.

| Raw | Rough | File                                            | Action                                                                                   |
| --: | ----: | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 749 |   542 | `indexer-envio/src/rpc/effects.ts`              | Watch; split if adding another effect family.                                            |
| 731 |   496 | `ui-dashboard/src/lib/network-fetcher/fetch.ts` | Watch; split fetch orchestration if another network-wide data source lands.              |
| 689 |   418 | `indexer-envio/src/handlers/sortedOracles.ts`   | Watch; split only with related oracle-handler work.                                      |
| 627 |   330 | `ui-dashboard/src/lib/leaderboard-hero.ts`      | Watch; split if hero KPI fallback or overlap logic grows again.                          |
| 608 |   464 | `ui-dashboard/src/lib/queries/leaderboard.ts`   | Watch; split leaderboard GraphQL fragments/queries if another leaderboard surface lands. |

- [ ] **Enable `tseslint.configs.recommended` on `indexer-envio`.** The current config deliberately omits the preset so the gating PR did not surface unrelated pre-existing nits. Flipping it on requires fixing `no-explicit-any`, `no-unused-vars`, and `no-require-imports` issues, adding `globals: globals.node`, and restoring the needed `@eslint/js` + `globals` devDeps.

## Envio v3 Migration Follow-Ups

- [ ] **Migrate the quarantined MockDb integration tests to `createTestIndexer` + HTTP-level RPC mocks.** v3 removes the old MockDb/processEvent path. The current blocker is architectural: `createTestIndexer` runs handlers through Envio's worker context, so the existing `_setMockX` in-process Maps are invisible to handlers. Use `msw` node-mode RPC interception so mocks cross the worker boundary, then re-enable the quarantined handler/integration suites in `indexer-envio/vitest.config.ts`.
- [ ] **Pin `envio` to stable `^3.0.0` once released.** The migration currently targets `3.0.0-rc.0`; after the stable release, bump the dependency, regenerate code, and rerun codegen/typecheck/tests to catch API drift.
- [ ] **Validate the Envio v3 backfill speedup against production sync time.** Baseline before the migration was roughly 15-40 minutes per push. After deploy, compare wall-clock from indexer deploy to caught-up sync and decide whether the medium-tier cache upgrade can remain deferred.
