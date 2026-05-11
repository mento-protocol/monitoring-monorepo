# Backlog

Active work only. Remove items from this file once they ship or are closed.
Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`,
or tests.

## Thoughtworks Technology Radar Follow-Ups

Source plan: `projects/mento-v3-monitoring/technology-radar-evaluation-plan.md`.
DORA metrics, CodeScene, and Dev Containers remain intentionally excluded.

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

### Feedback Sensors for Coding Agents

Why: repo knowledge currently lives in `AGENTS.md` and PR checklists, but
agents/humans still have to remember which gates apply. Path-aware feedback
should make the repo tell agents what to run before review, reducing repeated
Cursor/Codex findings.

- [ ] Add `scripts/agent-quality-gate.sh` with a dry-run mode that maps changed paths to required commands/checklists.
- [ ] Cover the main path groups: `indexer-envio`, `ui-dashboard`, `metrics-bridge`, `shared-config`, workflows, Terraform, docs.
- [ ] In execution mode, run only safe local checks: codegen, lint, typecheck, tests, Trunk checks as applicable. Never run deploys or Terraform apply.
- [ ] Link the script from `AGENTS.md` as the expected pre-PR handoff gate for agent-authored code changes.
- [ ] Trial on the next three PRs and note whether it prevents repeat review findings.

Acceptance: script is readable, supports dry-run, and catches or prevents at
least one issue before review.

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

## Volume Leaderboard

Current state: v3/v2 daily rollups, window snapshots, system-address
classification, aggregator config, the `/leaderboard` page, v2 aggregator
breakdown, per-row pool breakdown, top-10 concentration, and the v3 top-pools
list have shipped.

- [ ] **V3 aggregator flow surface.** Add table/chart coverage for `AggregatorDailySnapshot`, equivalent to the current v2 aggregator table. Surface `unknown` `txTo` addresses prominently for ongoing curation.
- [ ] **Cluster label UI parity.** The dashboard currently styles `cluster-*` as a plain pill in the v2 aggregator table, while `getClusterMetadata()` lives indexer-side. Expose cluster metadata to the dashboard (likely shared config or query field), then render an info tooltip and deployer explorer link wherever aggregator rows appear. See `docs/notes/volume-leaderboard-aggregator-clusters.md`.
- [ ] **Cohort + dormancy tiles.** Cohort breakdown joins `trader` against Arkham labels in Redis. New/dormant counts compare current-vs-previous window first-seen data.
- [ ] **Dedicated outlier-swaps drilldown.** The top-pools list exists for the v3 chart; the remaining gap is an outlier-swap surface for unusually large or skewed trades.
- [ ] **Pre-roll pool daily volume if the v3 stacked chart hits Hasura caps.** The current chart reads capped `TraderPoolDailySnapshot` rows. If this becomes visible at longer windows, add a `PoolDailyVolumeSnapshot` rollup keyed by `chainId-poolId-day`.
- [ ] **Corridor map + LP-friendliness column.** Net-direction graph from `TraderPoolDailySnapshot`; `lpScore = feesPaidUsdWei / max(imbalance * volumeUsdWei, epsilon)`.
- [ ] **Exact window-unique trader counts.** `mergeHeroSnapshot` adds snapshot, yesterday catch-up, and today's distinct trader counts without de-duplicating across those sources. Volume and swap counts are exact; unique traders remain approximate. Fix when needed by shipping distinct-trader sets or another compact overlap representation on `LeaderboardWindowSnapshot`.

## Virtual Pool Metrics

- [ ] **24h Volume tile for VPs.** Add per-exchangeId 24h USD volume to the VirtualPool header. Sourcing directly from `BrokerSwapEvent` would hit Hasura's 1000-row cap for active pairs; the proper fix is a new `BrokerExchangeDailySnapshot` entity keyed by `chainId-exchangeId-day`, updated alongside `BrokerDailySnapshot` in the broker handler. Requires a schema bump and full re-sync.

## Address Book

- [ ] **Server-side restore-from-Blob endpoint.** The import body cap is 4MB and Vercel's serverless body limit prevents raising it much further. If snapshots exceed that size, add `POST /api/address-labels/restore?pathname=...` to pull the snapshot directly from Vercel Blob and run the same validation/import pipeline. Decide explicitly whether cron/admin restores should preserve report author/timestamp metadata, since upload imports intentionally re-stamp reports to the importing session.
- [ ] **Report-only addresses need a UI surface.** The address-book page currently builds rows from `contractRows + customRows`, so an address with a forensic report but no label is not reachable from the index. Either add `/address-book/reports` or include report-only rows in the main address book, deduped against contract + custom rows.
- [ ] **Drop the legacy dual-read in `getLabels` / `getLabel`.** After production has run `POST /api/address-labels/migrate-flat` and confirmed `legacyDropped: true`, remove legacy reads from `ui-dashboard/src/lib/address-labels.ts`, delete the migration route + tests, and then drop `KNOWN_LEGACY_KEYS`.

## Dashboard Data Correctness

- [x] ~~**Live `href` on the global "Sign in" link for cmd/ctrl/middle-click.**~~ Done in PR #389: `AuthStatus` now builds the rendered anchor from `useLiveLocation()`, a `useSyncExternalStore` wrapper around `pushState` / `replaceState` / `popstate`, so modified clicks and "open in new tab" use the same current callback URL as ordinary navigation. Component tests cover `replaceState` search-param updates, `pushState` path changes, `popstate` back navigation, and hydration correction.
- [ ] **Volume chart partial signal on the homepage.** Strict `tokenDecimalsKnown !== true` gating now exists in the valuation helpers, but `VolumeOverTimeChart` only receives `hasSnapshotError`. When untrusted-decimal pools are skipped, the headline can still look like a confident low/zero value. Add `volumePartial` alongside the existing `tvlPartial` plumbing.
- [ ] **Pool detail tab panels gate on decimal trust state.** The top overview charts now receive `thresholdsLoading` / `thresholdsError`, but tab-local charts and tables still parse raw amounts with `pool.tokenNDecimals ?? 18`. Under an EXT query failure or `tokenDecimalsKnown=false`, those tabs can render schema-default-scaled balances. Add a page-level trust banner or per-tab gating.

## File Size And Lint Hygiene

Current line counts were refreshed on 2026-05-11. `raw` is physical lines;
`rough` approximates the ESLint `max-lines` count after skipping blanks and
comments. Refresh before starting a split.

|  Raw | Rough | File                                                 | Action                                                                                                                     |
| ---: | ----: | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1567 |   907 | `indexer-envio/src/pool.ts`                          | Highest-priority split before adding more pool behavior; under the effective hard cap but far past the readability budget. |
|  933 |   708 | `indexer-envio/src/rpc/pool-state.ts`                | Split RPC mocks/caches/fetchers when touching pool-state RPC.                                                              |
|  750 |   542 | `indexer-envio/src/rpc/effects.ts`                   | Watch; split if adding another effect family.                                                                              |
|  738 |   530 | `ui-dashboard/src/lib/address-labels/import.ts`      | Watch; split restore/import validators if the Blob restore endpoint lands.                                                 |
|  738 |   547 | `ui-dashboard/src/lib/queries/pools.ts`              | Watch; split by pool-detail/global/bridge domains if adding more queries.                                                  |
|  732 |   496 | `ui-dashboard/src/lib/network-fetcher/fetch.ts`      | Watch; split fetch orchestration if another network-wide data source lands.                                                |
|  690 |   418 | `indexer-envio/src/handlers/sortedOracles.ts`        | Watch; split only with related oracle-handler work.                                                                        |
|  675 |   605 | `ui-dashboard/src/components/global-pools-table.tsx` | Split if touching the table; it is just over the effective soft budget.                                                    |

- [ ] **Enable `tseslint.configs.recommended` on `indexer-envio`.** The current config deliberately omits the preset so the gating PR did not surface unrelated pre-existing nits. Flipping it on requires fixing `no-explicit-any`, `no-unused-vars`, and `no-require-imports` issues, adding `globals: globals.node`, and restoring the needed `@eslint/js` + `globals` devDeps.
