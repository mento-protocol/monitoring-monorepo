# Backlog

## Thoughtworks Technology Radar follow-ups — lightweight implementation plans

Source plan: `projects/mento-v3-monitoring/technology-radar-evaluation-plan.md`. These are the Radar recommendations we want to pursue now: **1, 2, 3, 5, and 6**. DORA metrics (#4), CodeScene (#7), and Dev Containers (#8) are intentionally excluded for now.

### 1. `axe-core` accessibility checks for dashboard UI ✅

Done. `vitest-axe@1.0.0-pre.5` + `axe-core` wired in `ui-dashboard/package.json`; 26 tests across 4 consolidated files under `ui-dashboard/src/__tests__/a11y/` (badges, sortable tables + empty/error/loading shells, controls — labelled `<select>`, `radiogroup`, `tablist` — and skeletons). Per-variant label assertions on every badge family catch silent label-drift refactors that pure axe runs miss. Pool tablist test imports the real `TABS` source so it can't drift behind the page. Total runtime ~1.5s, well under the 30s budget. No broad suppressions, no Plotly certification. See `ui-dashboard/AGENTS.md` "Dynamic content accessibility" for the maintenance contract.

Follow-up (deferred from PR review):

- [ ] **Roving `tabIndex` on `BridgeStatusFilter` radio group.** The component documents itself as implementing the WAI-ARIA radio-button keyboard contract (it has arrow-key handlers in `bridge-status-filter.tsx:26-47`) but every `role="radio"` button is in the tab order — the WAI-ARIA pattern wants only the active option tabbable, with arrow keys moving focus. Component-side fix: add `tabIndex={selected === ... ? 0 : -1}` and assert it in `controls.a11y.test.tsx`. Flagged by codex during PR #339 review.

### 2. Browser-based component/interaction testing pilot

Why: jsdom cannot prove real-browser behavior for Plotly, focus, hydration, layout, and stateful UI interactions. This repo already requires interaction tests for stateful data/UI changes; we need a small real-browser safety net for the flows that matter.

Lightweight plan:

- [ ] Spike Playwright Component Testing first; fall back to a minimal Playwright app-level harness if Next.js 16 / React 19 setup is too awkward.
- [ ] Use deterministic GraphQL fixtures/stubs; never hit live Hasura/Envio in tests.
- [ ] Cover 2–3 flows only: network switching, pool detail tab navigation, and degraded Hasura/query states.
- [ ] Add a `test:browser` script but do not make it required until runtime/flakiness is known.
- [ ] Record setup friction, runtime, and whether the tests catch behavior Vitest cannot.

Acceptance: headless run is stable, fixture-driven, and adds <2m if promoted to a PR-required check.

### 3. Feedback sensors for coding agents

Why: repo knowledge currently lives in `AGENTS.md` and PR checklists, but agents/humans still have to remember which gates apply. Path-aware feedback should make the repo tell agents what to run before review, reducing repeated Cursor/Codex findings.

Lightweight plan:

- [ ] Add `scripts/agent-quality-gate.sh` with a dry-run mode that maps changed paths to required commands/checklists.
- [ ] Cover the main path groups: `indexer-envio`, `ui-dashboard`, `metrics-bridge`, `shared-config`, workflows, Terraform, docs.
- [ ] In execution mode, run only safe local checks: codegen, lint, typecheck, tests, Trunk checks as applicable. Never run deploys or Terraform apply.
- [ ] Link the script from `AGENTS.md` as the expected pre-PR handoff gate for agent-authored code changes.
- [ ] Trial on the next three PRs and note whether it prevents repeat review findings.

Acceptance: script is readable, supports dry-run, and catches or prevents at least one issue before review.

### 5. `mise` toolchain management trial

Why: tool versions are currently spread across `.node-version`, `packageManager`, Trunk runtimes, README/setup docs, and Terraform config. `mise` is only worth adding if it reduces setup drift for fresh worktrees and agent sessions.

Lightweight plan:

- [ ] Inventory current version sources for Node, pnpm, Terraform, Python, Trunk, and setup scripts.
- [ ] Draft a minimal `mise.toml` for the tools where version drift actually hurts.
- [ ] Test fresh-shell setup: `mise install`, `pnpm install`, codegen, typecheck, and tests.
- [ ] Decide whether `mise` is canonical or optional convenience.
- [ ] If canonical, update docs and remove/clarify duplicate version declarations where safe.

Acceptance: setup becomes simpler than today. Reject if it just adds another version source of truth.

### 6. Targeted mutation testing baseline

Why: normal coverage can tell us code executed while missing the invariant. Monitoring logic has subtle failure modes — trading-seconds math, severity thresholds, pool IDs, degraded-mode fallbacks — where mutation testing can expose weak assertions.

Lightweight plan:

- [ ] Evaluate StrykerJS or equivalent against one narrow pure-logic target first, likely `ui-dashboard/src/lib/weekend.ts`.
- [ ] Keep mutation testing non-blocking and out of required CI until runtime/noise is proven.
- [ ] Configure the smallest useful scope; exclude generated files, tests, GraphQL barrels, ABIs, config-only files, and runtime-heavy RPC/dev-server paths.
- [ ] Classify surviving mutants as real test gaps, equivalent mutants/noise, or tool limitations.
- [ ] Add/improve tests only for real gaps, then record runtime and mutation score.
- [ ] Consider expanding next to pool ID/helpers and `metrics-bridge` rebalance probe/check logic.

Acceptance: finds at least one real assertion gap or gives high confidence on a critical module with acceptable manual/nightly runtime.

## Volume Leaderboard — follow-up PRs after PR 1 (indexer foundation)

PR 1 landed the schema entities + `caller`/`txTo`/`volumeUsdWei` on `SwapEvent` + handler population + `computeSwapUsdWei`. The `TraderDailySnapshot`, `TraderPoolDailySnapshot`, `AggregatorDailySnapshot`, `AggregatorTraderDayMarker`, `TraderPoolDayMarker` entities exist but no handlers write to them yet (empty tables on deploy — fine; PR 2 fills them).

Sequence (each PR self-contained, deploy-able):

- [ ] **PR 2 — Snapshot upsert logic.** In FPMM + VirtualPool swap handlers, upsert `TraderDailySnapshot`, `TraderPoolDailySnapshot`, `AggregatorDailySnapshot`. Use marker entities (`TraderPoolDayMarker`, `AggregatorTraderDayMarker`) to dedupe `uniquePools` / `uniqueTraders` increments. Requires:
  - `src/system-addresses.ts` — `isSystemAddress(chainId, addr)` checking `Pool.rebalancerAddress`, Mento Broker, NTT transceivers (`config/nttAddresses.json`), Yield Split (`feeToken.YIELD_SPLIT_ADDRESS`), treasury contracts. Cache resolved set per chain.
  - `src/aggregators.ts` + `config/aggregators.json` — per-chain `txTo → canonical name` lookup. Seed Squid (Celo: `0xce16F69375520ab01377ce7B88f5BA8C48F8D666`), Jumper/LI.FI (`0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`), 0x ExchangeProxy, 1inch AggregationRouter v6, Paraswap Augustus, OpenOcean Exchange, CoW GPv2Settlement. Verify each address against the canonical docs site before shipping. Monad coverage will be sparse — fine.
  - Returns `"direct"` when `txTo` is the Mento Broker, `"system"` when it's a system address, `"unknown"` otherwise (surfaces gaps for follow-up address curation).
  - Consider adding a top-level `volumeUsdWei` to `TraderPoolDailySnapshot` (alongside the direction-split fields) so the dashboard's per-pool breakdown doesn't need to derive it from inflow+outflow.
  - Characterization tests: feed 5–10 mock `SwapEvent`s with mixed traders/pools/aggregators, assert exact upsert counts and aggregate values.
  - Schema-required, but no breaking changes — full re-sync on branch deploy to populate historical aggregates.

- [ ] **PR 3 — Leaderboard page MVP at `/leaderboard`.** Pure UI/queries, no schema. Reuses `SortableTh`, `Table`, `AddressLink`, `TimeSeriesChartCard`, `useGQL`. Volume hero + sortable table (rank / address / volume / swaps / pools / top-pool / flow badge / fees / last active) + 24h/7d/30d/All window pills + `Show system addresses` toggle + per-row expand for per-pool breakdown. Flow badge from `imbalance = |inflow - outflow| / total` over the trader's primary pool. **Cluster rendering**: when an `aggregator` value matches `cluster-*`, render the row with an info-icon tooltip (text: "These contracts share a deployer EOA — likely one operator running multiple contracts. No project identity confirmed.") and link the icon to the deployer's explorer URL via `getClusterMetadata(name)` from `indexer-envio/src/aggregators.ts`. Clusters are NOT system addresses — they rank alongside real users with the toggle off.

- [ ] **PR 4 — Concentration + cohort + dormancy tiles.** Hero-row tiles. Concentration computed client-side from top-50 `TraderDailySnapshot` rows (Hasura row cap is fine for top-50). Cohort breakdown joins `trader` against Arkham labels in Redis (see `ui-dashboard/src/lib/arkham.ts` for the storage layout). New / dormant counts via current-vs-previous-window `TraderDailySnapshot` first-seen comparison.

- [ ] **PR 5 — Aggregator flow tab.** Pie of share + table (aggregator / volume / unique traders / swap count) + stacked time series. Direct query on `AggregatorDailySnapshot`. Surfaces `unknown` `txTo` addresses prominently so we can curate the aggregator config over time.

- [ ] **PR 6 — Per-pool top-N + outlier-swaps tabs.** Two more tabs below the main table.

- [ ] **PR 7 — Corridor map + LP-friendliness column.** Net-direction graph from `TraderPoolDailySnapshot`; `lpScore = feesPaidUsdWei / max(imbalance × volumeUsdWei, ε)` as a sortable column.

### Cluster aggregator labels — design notes

The `cluster-<first-16-hex-of-deployer-EOA>` aggregator label (added 2026-05-04) flags contracts that share a deployer EOA but have no public project identity (typical MEV/MM operator pattern: one EOA deploys multiple unverified router contracts to shard volume). Currently labels:

- `cluster-7dc08ec28f299c06` (Celo, deployer `0x7dc08ec28f299c062d2941de1f9cfb741df8f022`) — 16 contracts, all deployed via the CREATE3 factory `0xba5Ed099…ba5Ed`, Binance-funded operator. Code iteration (one fresh build per address, unique bytecode hashes 18–26 KB) — NOT defensive rotation. Major refactor on 2026-03-29 took success rates from ~37% to >99.7% on Mento legs.

Three Celo independents (`0x5dc3065e...`, `0x20216f30...`, `0x03637359...`) and two Monad addresses (`0xdb9b1e94...` MetaMask Delegation Manager, `0xf33cec38...` Gnosis Safe) were investigated 2026-05-04 but deliberately left as `unknown`:

- **Why not label single-contract deployers** (e.g. `0x5dc3065e`)? One contract per deployer = no clustering signal. Without a project identity, labeling adds no information beyond what a per-`txTo` drill-down would already show.
- **Why not preemptively scan deployer histories**? Aggregator-config should reflect contracts we've actually observed driving Mento volume. A periodic audit of the `unknown` bucket (quarterly) is the right cadence to expand this.
- **Why not blanket `mev-*` labels**? "MEV" is an inference about behavior. Cluster grouping is a fact (shared deployer). Stick to facts; let dashboard tooltips explain the "likely MEV / MM" interpretation.

Expansion procedure: when a new entry shows up in the top-N of `AggregatorDailySnapshot.aggregator = "unknown"`, pull `lastSeenAggregatorAddress`, look up the deployer on celoscan/monadscan, and check whether other contracts in our `unknown` bucket share that deployer. If ≥2 contracts cluster, add a new `cluster-<first-16-hex-of-deployer-EOA>` label.

### Deferred from PR 1

- [x] ~~**`LeaderboardWindowSnapshot` entity for hero metrics.**~~ Done: schema entities (`LeaderboardWindowSnapshot`, `BrokerLeaderboardWindowSnapshot`, `LeaderboardChainState`) + heartbeat-driven flush in `indexer-envio/src/leaderboardWindowFlush.ts` + dashboard rewire in `page-client.tsx`. Hero tiles read the pre-rolled snapshot for `[windowStart, yesterday]` and add today's partial from a small `TraderDailySnapshot` direct query. `mergeHeroSnapshot()` in `ui-dashboard/src/lib/leaderboard.ts` does the merge. Top-10 concentration uses the existing top-50 query as numerator and the snapshot total as denominator — exact end-to-end. The "≈ Approximate values for this window" banner is gone.

  Daily-volume chart still derives from the capped `TRADER_DAILY_TOP` rows — follow-up: paginate `TraderDailySnapshot` keyset on `(timestamp desc, id asc)` so the chart is exact too.

### Volume Leaderboard — follow-ups noted during PR #328 review

- [ ] **Dedupe overlap between snapshot range and today in unique-trader count.** `mergeHeroSnapshot` adds the snapshot's `uniqueTraders` and today's distinct trader count without de-duplicating; a trader active both in `[windowStart, yesterday]` and today is counted twice. Acceptable today (today's distinct count is small, usually <50). Fix when needed: ship `distinctTraders: [String!]!` on `LeaderboardWindowSnapshot` so the dashboard can subtract the overlap. Source: claude[bot] review on PR #328 (finding 2).
- [x] ~~**Date-range filter on `getWhere.chainId.eq` during heartbeat flush.**~~ Closed after audit: Envio's generated `getWhere` API still exposes single-field `eq` / `gt` / `lt` operations only, and the exact `all` window still needs full historical rows for unique-trader dedupe. A timestamp-only query would fetch all chains and can be worse than the current chain query; a lower-bound date filter would make `all` incorrect. The safe future shape is a dedicated closed-day/all-time accumulator, not a standalone filter patch. Source: claude[bot] review on PR #328 (finding 4).
- [x] ~~**Stale-snapshot detection when a chain has no events for ≥1 UTC day.**~~ Done in PR #339 (final shape after two codex iterations). Two-threshold rule on `windowKey ∈ {"7d","30d","90d"}`: `snapshotDay < today-2d` → STALE (snapshot AND today's partial dropped, amber banner); `snapshotDay = today-2d` → DEGRADED (snapshot kept, lighter banner — pre-first-swap-of-day state where yesterday's data isn't yet in either source); `snapshotDay ≥ today-1d` → FRESH. `all` and `24h` rows never flagged. Hero rollup extracted to `lib/leaderboard-hero.ts`; banners to `_components/hero-data-quality-banners.tsx`. `top10Concentration` applies the same chain mask to numerator and denominator. Source: claude[bot] review on PR #328 (finding 3).

## Refactor — long files (next candidates after PR #263)

PR #263 split `ui-dashboard/src/app/pool/[poolId]/page.tsx` from 2,831 → 470 lines. Same playbook (characterization tests first, then per-module extraction, snapshot-diff verification per commit) applies to the rest. Ranked by impact × tractability:

### Tier S — clear wins (>1k lines, dense logic)

- [ ] **`indexer-envio/src/rpc.ts` — 1,882 lines.** Indexer RPC adapter (per-method handlers + retry/dispatch). No browser-level tests cover it; characterization tests for retry + dispatch are non-optional before splitting. Highest cognitive-load file in the repo.
- [ ] **`indexer-envio/src/handlers/fpmm.ts` — 1,022 lines.** Split per event type (Swap / Rebalance / LiquidityChange / etc.) — mirrors the pool-page tab split.

### Tier A — UI page refactors (need characterization tests first)

- [x] ~~**`ui-dashboard/src/app/bridge-flows/page.tsx` — 909 lines.**~~ Done in PRs #284 (characterization tests), #287 (TransfersTable + row cells), #289 (RouteDeliveryTile + BridgeOverviewSection). Now 311 lines.
- [x] ~~**`ui-dashboard/src/components/breach-history-panel.tsx` — 823 lines.**~~ Done in PRs #285 (characterization tests), #286 (DurationFilter + BucketFilter), #290 (BreachTable + BreachRow + filter helpers). Now 403 lines.
- [x] ~~**`ui-dashboard/src/app/address-book/AddressBookClient.tsx` — 713 lines.**~~ Done in PRs #283 (characterization tests), #288 (AddressTableRow + row helpers), #291 (ImportDialog + import/export lib). Now 277 lines.

### Tier B — lib/utility splits (low-risk, no UI)

- [x] ~~**`ui-dashboard/src/lib/queries.ts` — split by domain.**~~ Done in PRs #277 (`pools.ts`), #278 (`config.ts`), and the in-flight final slice (`lp.ts` + `ols.ts` + `protocol.ts` + drop exemption). `queries.ts` is now a 6-line barrel.
- [x] ~~**`ui-dashboard/src/app/api/address-labels/import/route.ts` — 808 lines.**~~ Done in PR #280 (handlers extracted to `lib/address-labels/import.ts`; route is now a 103-line HTTP wrapper).
- [x] ~~**`ui-dashboard/src/lib/fetch-all-networks.ts` — 610 lines.**~~ Done in PR #279 (split into `lib/network-fetcher/{types,fetch}.ts`; the original path is a 9-line barrel).

### Tier C — defer (only if related work touches them)

- `indexer-envio/src/pool.ts` (677), `handlers/wormhole/nttManager.ts` (578) — split if working on indexer
- `ui-dashboard/src/components/global-pools-table.tsx` (638) — has 511 lines of tests; low-risk to split, but cognitive load isn't bad
- `lib/rebalance-check.ts` (506), `lib/homepage-og.ts` (494), `breakers.ts` (486) — under the threshold; defer

## Lint hygiene

- [x] ~~**Add an ESLint config to `indexer-envio/`.**~~ Done (this PR): `indexer-envio/eslint.config.mjs` lands with `max-lines: 1000` for `src/**/*.ts`. `.trunk/trunk.yaml` no longer excludes `indexer-envio/**` from the eslint linter, so `trunk check` now lints it. Strict-typescript preset (`tseslint.configs.recommended`) intentionally NOT enabled — would surface ~39 pre-existing nits (no-explicit-any, no-unused-vars, no-require-imports). Backlog item: tighten when the existing nits get cleaned up.
- [x] ~~**Add an `unused-imports` lint rule across all packages.**~~ Done (this PR): `eslint-plugin-unused-imports` wired into all four `eslint.config.mjs` files with `unused-imports/no-unused-imports: "error"`. Caught two real dead imports in `indexer-envio/test/rebalancedUsd.test.ts` and `swap-reserves.test.ts` plus two stale `eslint-disable` directives — all fixed in the same PR.
- [ ] **Enable `tseslint.configs.recommended` on `indexer-envio`.** The current `indexer-envio/eslint.config.mjs` deliberately omits the strict-typescript preset (and `js.configs.recommended`) so the gating PR didn't surface unrelated pre-existing nits. Flipping it on requires fixing roughly 39 errors first: `@typescript-eslint/no-explicit-any` (mostly in `test/rpcCache.test.ts`), `@typescript-eslint/no-unused-vars` (test files, plus a few `assigned but never used` cases in src), `@typescript-eslint/no-require-imports` (`test/dynamicRegistration.test.ts` uses `require()` on rescript-emitted .res.js modules — needs a per-file `require-imports` exemption or a dynamic `import()` rewrite). When fixing, also add `globals: globals.node` to the config's `languageOptions` block (otherwise `no-undef` flags `process`, `Buffer`, etc.), and re-add the `@eslint/js` + `globals` devDeps that were dropped because the scoped config doesn't reference them. Mirror the metrics-bridge / shared-config layout once the cleanup lands.

## Follow-ups deferred from PR #288 (address-book extract)

- [x] ~~`_lib/address-book-rows.test.ts` — dedicated unit tests for `buildContractRows`, `buildCustomRows`, `filterRows`, and `unknownChainNetwork`.~~ Done in PR #333: 19 tests covering happy paths, unknown-chain-network fallback sentinels, and filter edge cases.

## Cosmetic follow-ups deferred from PR #263

Pre-existing behavior carried over verbatim from the monolithic pool page; flagged by claude[bot] review but kept out of scope of the refactor PR.

- [x] ~~`_tabs/reserves-tab.tsx` — gate the `Total (USD)` `<Th>` on `showUsd`.~~ Done in PR #332.
- [x] ~~`_tabs/swaps-tab.tsx` — replace cumulative-stats IIFE with a hoisted `lastSnapshot` const.~~ Done in PR #332.

## Follow-ups deferred from PR #304 (per-pool revenue leaderboard)

- [x] ~~**Component-level tests for `RevenueByPoolTable`.**~~ Done in PR #334: sort transitions, label fallback (truncated address when `poolLabels` lookup misses), and partial-data render assertions are now covered. (Partial-data shell additionally got an axe-coverage test in PR #342.)
- [x] ~~**Tests for `useProtocolFees` orchestration.**~~ Done: `src/hooks/__tests__/use-protocol-fees.test.ts` — 13 tests covering happy path, fees/rates/labels rejection, all-fail, hasura URL guard, and per-chain isolation.
- [x] ~~**URL-persisted sort state on `RevenueByPoolTable` and `GlobalPoolsTable`.**~~ Done in this PR: new `useTableSort<K>` hook in `lib/use-table-sort.ts` reads sort key + direction from search params via `useSearchParams` and writes back via `useRouter().replace()`. Strips params when state matches defaults; canonicalizes malformed/partial URL params on mount so the address bar always describes the rendered state. Per-table `paramPrefix` (`leaderboard`, `pools`) keeps params from colliding. Smoke integration tests on both real consumers verify the wiring (URL state → `aria-sort`).
- [x] ~~**Per-chain truncation flag on the leaderboard.**~~ Done in PR #306: `buildRows` derives per-window flags from each chain's `isTruncated` AND the oldest returned transfer's timestamp vs each window's lower bound, so a window is flagged only when the cap actually clipped data inside it. Each `FeeColumn` carries a `truncatedField` symmetric to `unpricedField`; `approxAnnotation(row, column)` checks both per column. Tests cover all (truncated × unpriced) combinations and per-window cases (oldest-older-than-30d → only All-time; oldest-inside-30d → 30d + All-time; etc.).

## Follow-ups deferred from PR #330 (forensic reports — Phase 1)

- [x] ~~**Backup parity for forensic reports.**~~ Done in this PR: extended `/api/address-labels/backup` to load both labels and the full `reports` hash via a new `getAllReports()` HGETALL helper, and embed both under `addresses` + `reports` in the same daily Blob snapshot (one cron, one blob — keeps the team-plan slot count steady and avoids partial restores). `AddressLabelsSnapshot.reports?` is back-compat optional so old snapshots still parse. The `/api/address-labels/import` snapshot path now also restores reports verbatim (preserves the snapshot's `version` / `createdAt` / `updatedAt`) via a new `importReports()` HSET helper, with `isSnapshot` recognising the new `reports` key. Restore enforces the same content invariants as the live editor (`validateSnapshotReports` mirrors `sanitizeReportInput` — non-empty body, body ≤ 50KB, title ≤ 200). Manual `/api/address-labels/export` now also includes `reports` so an export-then-reimport cycle preserves both halves.
- [ ] **Server-side restore-from-Blob endpoint.** Import body cap is currently 4MB (fits ~80 max-size reports + labels), which is comfortable headroom against current usage but a hard ceiling. Vercel's 4.5MB serverless body limit means raising it further isn't viable. If usage ever pushes past 4MB, a daily backup would become unrestorable through `/api/address-labels/import`. The right fix is a `POST /api/address-labels/restore?pathname=...` endpoint that pulls the snapshot directly from the Vercel Blob store (no body upload) and runs the same `handleSnapshot` pipeline. Tracked here because the failure mode is rare and not yet observed.
- [ ] **Report-only addresses need a UI surface.** The address-book page builds rows from `contractRows + customRows`. An address with a forensic report but no label has no row, so the report is unreachable through the UI after the modal closes. Options: (a) add a `/address-book/reports` index page listing every address with a report, or (b) include report-only rows in the main address book (deduplicated against contract + custom rows). Flagged by Codex on PR #330.
- [x] **Address labels: drop chain/global scope (mirror reports).** Done in PR #332 — labels now live in a single `labels` hash keyed by lowercase address. Migration runs via `POST /api/address-labels/migrate-flat` (cron-secret or session) which snapshots the legacy `labels:{chainId}` + `labels:global` hashes to Vercel Blob, merges into the new flat key (union tags, prefer most-recently-updated fields, earliest createdAt), verifies, then deletes the legacy keys. Idempotent.
- [ ] **Drop the legacy dual-read in `getLabels` / `getLabel`.** PR #332 ships a transition path where `getLabels()` and `getLabel(address)` read the flat hash plus every legacy `labels:{chainId}` / `labels:global` so the UI doesn't blank out between the deploy and the manual `POST /api/address-labels/migrate-flat` call. After production has run the migration and confirmed the response shows `legacyDropped: true`, remove the legacy half of the read in `ui-dashboard/src/lib/address-labels.ts` and delete the migration route + tests. Keep `KNOWN_LEGACY_KEYS` until the legacy half is gone, then drop that too.

## Follow-ups deferred from PR #339 (stale-snapshot detection)

- [x] ~~**`page-client.tsx` structural split.**~~ Done in PR #349: extracted `useHeroRollup()` to `_lib/use-hero-rollup.ts` (owns the snapshot/today queries, `mergeHeroSnapshot`, and `top10Concentration`) and the v2 producer + aggregator JSX panel to `_components/v2-leaderboard-section.tsx`. Page-client lands at 525 lines.
- [x] ~~**Catch up the missing closed UTC day instead of just flagging it.**~~ Done in this PR — the dashboard now fetches yesterday's closed-day rows from `TraderDailySnapshot` (gated on `degradedChains.length > 0`) and performs slice subtraction in `mergeHeroSnapshot`: drop the snapshot's first-day contribution (new `firstDay*` schema fields on `LeaderboardWindowSnapshot` / `BrokerLeaderboardWindowSnapshot`), then add yesterday + today, restoring the rolling-window's full N-day count. Chains supplemented this way drop from `degradedChains` so the banner only surfaces chains with genuinely missing data.

## Follow-ups deferred from PR #342 (axe-core a11y test infra)

Both items shipped together — `it.todo` blocks in `ui-dashboard/src/__tests__/a11y/controls.a11y.test.tsx` replaced with real assertions covering tabIndex distribution + arrow / Home / End key behavior, and the prod widgets now implement the WAI-ARIA roving-tabindex pattern.

- [x] ~~**`BridgeStatusFilter` keyboard contract.**~~ Done: roving tabindex with the lone tab stop following focus, not the selected prop after initial render. `ArrowLeft/Right/Up/Down` move focus + selection (automatic radiogroup activation), and `Home/End` jump to first/last. Wrapper carries `tabIndex={-1}` for the `interactive-supports-focus` lint rule without polluting the natural tab order.
- [x] ~~**Pool tablist keyboard contract.**~~ Done: same roving-tabindex helper on `<PoolTablist>` with manual activation. `ArrowLeft/Right` move focus only, `Home/End` jump to first/last, and click / Enter / Space activate the focused tab. Test uses `act()` + native `KeyboardEvent` dispatches via `bubbles: true` so React's synthetic event delegation picks up the keydown on the tablist wrapper.
- [x] ~~**`BucketFilter` keyboard contract + shared roving-tabindex helper.**~~ Done: extracted `useRovingTabIndex`, rewired `BucketFilter`, `BridgeStatusFilter`, and `PoolTablist`, and added `BucketFilter` a11y coverage for one tab stop, Arrow/Home/End behavior, stale controlled props, and axe.

## Follow-ups deferred from PR #335 (sign-in callback preservation)

- [x] ~~**Live `href` on the global "Sign in" link for cmd/ctrl/middle-click.**~~ Done in this PR: `AuthStatus` now builds the rendered anchor from `useLiveLocation()`, a `useSyncExternalStore` wrapper around `pushState` / `replaceState` / `popstate`, so modified clicks and "open in new tab" use the same current callback URL as ordinary navigation. Component tests cover `replaceState` search-param updates and `pushState` path changes.

## Follow-ups deferred from PR #367 (react-doctor diff gate)

PR #367 wired [react-doctor](https://github.com/millionco/react-doctor) into
the dashboard CI as a PR-only diff-mode gate (file-level `--fail-on warning`).

**Status update (PR #371 + PR #382 closed the cleanup):** PR #371 took
the score from **80 / 100 (1 error + 162 warnings)** to
**100 / 100 (0 issues)** by fixing every actionable category and
inline-disabling the remaining false-positives (architectural false alarms
or infeasible-without-bigger-refactor cases) with rationale. PR #382 kept
the dashboard at 100 / 100, removed the touched-file suppressions that were
still easy to trip in pool-detail/oracle/breach-history code, reinstalled the
React Doctor ESLint plugin, and added the full-score CI floor. PR #373 then extended
`ui-dashboard/AGENTS.md` § "URL state in client-only tables / filters"
to document WHY `useSearchParams` is the SSR-safe lazy-init source
(rationale for the `useState` lazy-init + hydration mechanic that
caught us mid-PR-#371). Items below that are checked were addressed
in those PRs; remaining unchecked items, if any are added later, are genuine
follow-up work.

### Cleanup PRs (reduce the backlog to zero)

- [x] ~~**`react-doctor/nextjs-no-side-effect-in-get-handler`** (1 error).~~
      Done: extracted the in-flight dedup pattern into `getOrDispatch()` so
      the GET handler body has no observable cache-mutation; the
      `inFlight.set/delete` lives inside the helper.
- [x] ~~**Next.js correctness pass** (~13 warnings).~~ Done:
  - `nextjs-missing-metadata` ×7 — server-component `page.tsx` shells with
    `export const metadata` / `generateMetadata` for every flagged page;
    client logic moved to `_components/<route>-page-client.tsx`.
  - `nextjs-no-use-search-params-without-suspense` ×3 — `auth-status.tsx`
    gained a local `<Suspense>` boundary; `useTableSort` and
    `useLeaderboardUrlState` keep `useSearchParams()` as the SSR-pass
    fallback with an inline disable pointing at the layout-level
    `<Suspense>` boundary (Cursor Bugbot bbc20b5f / Cursor CHANGES_REQUESTED
    on PR #371 caught the initial "drop the hook entirely" attempt —
    `useState` lazy initializers serialize on SSR and don't re-run on
    hydration, so `window.location.search` alone silently dropped
    URL params on direct page loads).
  - `nextjs-no-client-side-redirect` ×3 — `address-book/[address]/page.tsx`
    now redirects server-side via `redirect()` after sync `isValidAddress`;
    the two pool-detail redirects (legacy-id canonicalization and
    not-found-after-SWR-resolution) carry inline disables with the
    architectural rationale (they depend on client-side SWR data resolved
    post-mount).
- [x] ~~**Architecture pass — `no-giant-component` splits** (~11 components,
      5,134 lines).~~ Closed for the React Doctor gate: the dashboard now
      runs at **100 / 100 (0 diagnostics)** on `react-doctor --full`, and the
      concrete touched-file suppressions that kept re-triggering the diff gate
      (`PoolDetail`, `OracleTab`, `BreachHistoryPanel`) were removed in this
      branch. Remaining large-component suppressions are intentionally
      documented inline and no longer block the score-floor or diff gate.
- [x] ~~**`no-array-index-as-key` ×8.**~~ Done: 8 sites are static-length
      skeletons (TableSkeleton, TileGridSkeleton, etc.) that never reorder
      or filter — keys swapped to stable `\`skel-X-${i}\`` template literals
      with inline disables explaining the static-skeleton invariant.
- [x] ~~**Performance pass** (~63 warnings).~~ Done:
  - `js-combine-iterations` ×24 — `.map().filter()` consolidated into
    single-pass `.flatMap()`s.
  - `js-tosorted-immutable` ×14 — server-only and test sites converted
    to `arr.toSorted()`; **client-shipped sites kept as `[...arr].sort()`
    with inline disables** because the dashboard's TS target is ES2017
    with no polyfill, so `Array.prototype.toSorted` (ES2023) would crash
    Safari ≤15 / Chrome ≤109 (codex P2 ×5 caught the regression on
    PR #371; the actual client blast radius was 12 sites, not the 5
    codex flagged).
  - `async-await-in-loop` ×11 — most sites are sequential-by-design
    (rate-limited Arkham enrichment, paginated Hasura with early-exit,
    status-poll loops, Redis ops sharing a key); inline-disabled with the
    sequential-required rationale.
  - `js-flatmap-filter` ×5 — `.map().filter(Boolean)` → `.flatMap()`.
  - `rerender-state-only-in-handlers` ×4 — `useState` switched to
    `useRef` where the value never feeds render; `phase` in
    `bridge-redeem-cta` kept as state with disable (drives a conditional
    return the rule miss-detects).
  - `js-min-max-loop` ×2 — `arr.sort()[0]` replaced with single-pass
    `reduce` for min/max.
  - `js-index-maps` ×1 — built a `Map<key, row>` for the WoW-row lookup.
  - `async-defer-await` ×1 — `pool-og.ts` `Promise.allSettled([...])`
    keeps parallelism; inline-disabled (rule's "skip path" optimization
    only saves work on the <1% detail-failure path while losing the 200ms
    p50 win on every successful unfurl).
- [x] ~~**State & Effects pass** (~8 warnings).~~ Done:
  - `prefer-useReducer` ×4 — components flagged have legitimately
    independent state pieces (form fields, modal targets, filter pieces);
    inline-disabled with the rationale that a reducer would just rename
    the same setters.
  - `no-derived-useState` ×3 — props are one-shot seeds, not synced
    sources (parent remounts via `key=` when reset is needed).
  - `no-cascading-set-state` ×1 — three setStates inside one popstate
    handler are auto-batched by React 18+; inline-disabled.

### Optional react-doctor surfaces closed

The cleanup PR originally deferred wiring `react-doctor`'s ESLint plugin
alongside the standalone CLI for IDE-time inline warnings. That deferral is
closed: `eslint.config.mjs` now installs the plugin and mirrors the accepted
project-wide CLI silences so `pnpm lint` stays zero-noise while the standalone
CLI remains the authoritative full-score gate. The plugin and CLI still use
different disable comment syntaxes if a future rule needs a local exception:
the CLI honours `react-doctor-disable-next-line react-doctor/<rule>` while the
plugin honours `eslint-disable-next-line react-doctor/<rule>`.

- [x] ~~**Re-install the react-doctor ESLint plugin + add
      `eslint-disable-next-line` shims.**~~ Done: `eslint.config.mjs` now wires
      `react-doctor/eslint-plugin` for IDE-time coverage while mirroring the
      standalone CLI's accepted suppressions in config so `pnpm lint` stays
      zero-noise. `prefer-useReducer` remains disabled in ESLint for the
      upstream 0.1.x false-positive class; the standalone CLI remains the
      authoritative full-score gate.
- [x] ~~**Install `eslint-plugin-react-you-might-not-need-an-effect`.**~~ Done:
      installed and wired into ESLint. Its `no-event-handler` rule is disabled
      in both ESLint and `react-doctor.config.json` because it false-positives
      on the dashboard's debounced table search and URL-state synchronization
      helpers; the rest of the companion rule set remains available in-editor.

### Ratchet phase (after the cleanup lands)

Tighten the gate by un-silencing rules in
`ui-dashboard/react-doctor.config.json`:

- [x] ~~**`react-doctor/design-no-default-tailwind-palette`** (714 hits,
      silenced).~~ Closed as project convention for now: the dashboard uses
      Tailwind's slate/gray/indigo scale deliberately, and `pnpm lint` plus the
      React Doctor score-floor now enforce the accepted policy.
- [x] ~~**`react-doctor/design-no-em-dash-in-jsx-text`** (66 hits,
      silenced).~~ Closed as project convention: em-dashes remain allowed in
      dashboard copy.
- [x] ~~**`react-doctor/design-no-redundant-size-axes`** (12 hits) and
      **`react-doctor/design-no-bold-heading`** (7 hits, both silenced).~~
      Closed as project convention; these stay in the React Doctor ignore list
      rather than churn existing visual styling for score-only changes.
- [x] ~~**Drop the test/script override block.**~~ Tightened: hook-shaped test
      mocks were renamed so `react-hooks/rules-of-hooks` no longer needs a
      React Doctor override. `react-doctor/no-secrets-in-client-code` remains
      scoped to tests/scripts because placeholder public addresses in fixtures
      are intentional.

### Operational follow-ups

- [x] ~~**Reconsider `--fail-on warning` if the boy-scout-rule tax is too
      costly.**~~ Decision: keep `--fail-on warning` for the PR diff gate now
      that the full dashboard score is 100 and touched-file suppressions were
      cleaned up.
- [x] ~~**Periodically bump `react-doctor` itself.**~~ Done in this branch:
      bumped from `0.1.4` to `0.1.6`, reviewed the new rule surface, and kept
      the dashboard at **100 / 100**.
- [x] ~~**Score-floor CI job (optional).**~~ Done: the UI CI job now runs
      `react-doctor --full --score --offline` and fails unless the score is
      exactly `100`.
- [x] ~~**Bump TS target to ES2022+ (or add a `toSorted` polyfill) and
      remove the 12 client-side `js-tosorted-immutable` inline disables.**~~
      Closed by policy instead of runtime churn: client-shipped code keeps the
      Safari/older-Chrome-safe spread+sort form, and the rule remains accepted
      in `react-doctor.config.json` / ESLint config.

## Follow-ups deferred from Phase 2 (BiPoolExchange indexer + dashboard refactor)

- [ ] **24h Volume tile for VPs.** Per-exchangeId 24h USD volume on the
      VirtualPool header. Sourcing from `BrokerSwapEvent` by exchangeId would
      hit Hasura's 1000-row cap for active pairs; the proper fix is a new
      per-exchange daily-rollup entity (`BrokerExchangeDailySnapshot` keyed
      by `chainId-exchangeId-day`) updated alongside `BrokerDailySnapshot` in
      the broker handler. Requires a schema bump + full re-sync, so deferred
      out of the Phase 2 PR which already ships one.

- [x] ~~**`@index` on `BiPoolExchange.wrappedByPoolId`.**~~ Done:
      `wrappedByPoolId` is indexed in `indexer-envio/schema.graphql`, so the
      dashboard's `POOL_V2_EXCHANGE` filter no longer grows as an O(N)
      exchange-table scan after the next schema re-sync.

- [x] ~~**Sentinel for orphan exchanges (`wrappedByPoolId` will-never-be-set).**~~
      Done: `BiPoolExchange.wrappedByPoolIdChecked` is persisted on create,
      destroy, and self-heal seed paths. `ensureBiPoolExchange` and preload
      now skip the repeated `Pool.getWhere.wrappedExchangeId.eq()` lookup once
      the row is known wrapper-checked, while late VP-side self-heal can still
      patch `wrappedByPoolId` directly.

- [x] **Block-scoped `getPoolExchange` reads.** Done: `fetchPoolExchange`
      now requires the event block and routes `getPoolExchange` through
      `readContractWithBlockFallback` at that block. `poolExchangeEffect`
      carries `blockNumber`, and all callers (`ExchangeCreated`,
      `BucketsUpdated` / `SpreadUpdated` self-heal, and VP
      `selfHealWrappedExchangeId`) pass their event block. Focused coverage
      pins that the RPC call receives the supplied block number and rejects
      latest-block fallback results, preventing historical catch-up from
      stamping future config or destroyed-state structs onto past rows.

- [x] **`fetchTokenDecimalsScaling` test mock layer.** Done: added
      `_setMockTokenDecimalsScaling(chainId, addr, fn, value)` +
      `_clearMockTokenDecimalsScaling`, re-exported them through the existing
      test barrels, and rewired VP heal-pipeline tests to use direct
      decimals0/decimals1 mocks instead of live RPC or ERC20 fallback mocks.
      The mock supports `null` for transient failure simulation.

## Indexer sync-perf follow-ups (after PRs #329 / #341 / #346 / #351 / #353 / #356)

Captured during the medium-tier benchmarking session that landed the
createEffect migration, structured logging, primary/fallback RPC swap,
rate-limit-regex extension, cache-true on immutable effects, and the
block-depth-aware fallback dispatch. After all six PRs, full sync on
medium tier sits at ~66–72 min cold-cache and matches that within
noise on cache-warm. The remaining levers below are the ones that
were considered, sized, and explicitly deferred — not unknowns.

- [x] ~~**Lever 4 — read entity store instead of RPC where the indexer already has the data.**~~ Closed after audit: the hot `getRebalancingState` paths already use entity-derived state when the Pool row has live oracle, reserve, threshold, orientation, and decimals inputs (`UpdateReserves` with an event reserve override, `Rebalanced` after sibling reserve events, and threshold updates from the local median path). `getReserves` is no longer used for swap/update hot paths; the remaining read is `blockNumber - 1` for rebalance notional and cannot be answered from the post-event Pool row. `rebalanceIncentiveAtBlock` may only skip the permanent `-2` sentinel: short-circuiting on a real `Pool.rebalanceReward` would use a latest-seeded value during historical re-sync, which the focused `rebalancedUsd` tests intentionally reject.
- [x] ~~**Cache `resolveFeeTokenMeta` (decimals + symbol) via Effect API.**~~ Done: `feeTokenMetaEffect` wraps `resolveFeeTokenMeta` with `cache: true`; Broker swaps and protocol-fee transfers now call it through `context.effect`. The UNKNOWN/18 degraded path sets `context.cache = false` so transient metadata failures still retry on later events.
- [x] **Route `probeFunction` in `breakers.ts` through `readContractWithBlockFallback`.** Done: breaker-kind selector probes now use the shared wrapper, preserving unscoped-read semantics while gaining the same rate-limit retry / fallback path as the rest of the RPC layer. Focused tests pin rate-limit retry and zero-data selector-miss classification.
- [x] ~~**Automate the cross-deploy "Save Cache" snapshot step.**~~ Closed for now: current Envio docs still describe hosted cache save/restore as dashboard actions, and `envio-cloud --help` exposes no cache command. There is no repo-side API/CLI hook to wire into `pnpm deploy:indexer:promote` yet; re-open when Envio exposes a programmable cache-save command.
- [x] ~~**Investigate Monad RPC archive depth as a follow-up to PR #336 / PR #346.**~~ Done: see `docs/notes/monad-rpc-archive-depth-2026-05-10.md`. Public QuickNode docs still list Monad as pruned to "Over 40,000 recent blocks available"; Monad docs publish provider gas/range limits but not request-rate limits; dRPC public docs do not state Monad archive retention depth. Keep the current block-depth-aware fallback policy.
- [x] ~~**Per-effect cache observability in the dashboard / alerts.**~~ Done:
      `terraform/alerts/rules-indexer.tf` adds a warning alert on
      `increase(envio_effect_cache_invalidations_count[5m]) > 0`, grouped by
      effect, so schema drift or cache-poisoning regressions surface in Slack.

## PR 1.6 — Asymmetric pool follow-ups (deferred from PR #366)

Carved out of PR #366's review cycles when the marginal-cost of additional codex rounds outweighed shipping the existing improvements. Both are real concerns but bounded in user-visible impact.

- [x] **`entryRebalanceThreshold` for asymmetric pools.** Done on `origin/main`: `breachEntryThreshold` now captures the effective entry threshold for asymmetric zero-side breaches, `nextOpenBreachEntryThreshold` preserves that capture across side flips, and focused coverage lives in `indexer-envio/test/pool.test.ts` + `indexer-envio/test/deviationBreach.test.ts`. Codex P2 from round 9 (comment 3214513401).
- [x] **Dashboard consumers should gate on `hasHealthData`.** Already done on
      `origin/main`: `computeHealthStatus` returns `N/A` for
      `hasHealthData === false` after the stale-oracle check, the global
      pools table calls `computeEffectiveStatus` / `computeHealthStatus`
      instead of recomputing directly, and `homepage-og.ts` uses
      `computeEffectiveStatus` for health buckets. Coverage lives in
      `ui-dashboard/src/lib/__tests__/health.test.ts`.

## PR 1.7 — Untrusted-decimals dashboard tightening (deferred from PR #366)

Round-12 codex follow-ups to the round-10/11 `tokenDecimalsKnown` gating sweep. Each one is a real correctness improvement but the cost is invasive enough to warrant a focused follow-up PR rather than another #366 round.

- [x] **`poolTvlUSD` should return `number | null` not `number` for
      untrusted pools.** Already done on `origin/main`: `poolTvlUSD` returns
      `null` unless `tokenDecimalsKnown === true`, callers skip null from
      sums / render unavailable values, and coverage in
      `ui-dashboard/src/lib/__tests__/tokens.test.ts` pins both
      `false` and `undefined` trust states.
- [ ] **Treat `tokenDecimalsKnown === undefined` as untrusted in valuation paths.** Currently the gate is `=== false` so undefined falls through to `tokenNDecimals ?? 18`. Codex argues this leaks fake USD figures during EXT-query failure / schema-lag windows. Trade: stricter `!== true` semantics break ALL pools' USD figures during the ~10-15min indexer redeploy window (existing pools transiently lose their trust signal). Pre-PR-1.5 indexers pre-rollout would also blank universally. Real fix likely needs an explicit "this came from a successful EXT query" sentinel separate from the field value, OR coordinate the rollout so the indexer field always lands first. Codex P2 from PR #366 round 12 (comment 3214690061). Estimate: ~1h with new sentinel design.
- [ ] **Add `AbortSignal` to the `usePoolWithThresholds` polling extension.** `useGQL` (project hook around graphql-request) doesn't currently expose `AbortSignal` to consumers. A wedged Hasura connection on the trust-flag EXT query could stick the SWR poll instead of failing open and retrying. Real fix: thread `AbortSignal` through `useGQL` (and `useGQL`'s underlying fetcher) — touches the shared graphql layer used by every dashboard query. Codex P2 from PR #366 round 12 (comment 3214690063). Estimate: ~45 min, touches shared graphql plumbing.

## PR 1.8 — Trust-state plumbing across remaining dashboard surfaces (deferred from PR #372)

PR 1.7 wired `thresholdsLoading` / `thresholdsError` (from `usePoolWithThresholds`) and a `tvlPartial` flag into the global TVL hero, the OG `partial` flag, the pool-detail TVL/Volume/Reserves panels, and the global TVL chart's bucket-skip logic. Codex's round-2 review on PR #372 (comments 3215163047, 3215163050, 3215163051) flagged remaining surfaces where trust-state isn't yet plumbed.

- [ ] **Volume chart partial signal on the homepage.** `VolumeOverTimeChart` consumes `hasSnapshotError` for snapshot failures but not a separate trust-flag signal. When `tokenDecimalsKnown !== true` for any pool, `buildDailyVolumeSeries` skips those rows and `computeHeadline` can render `$0.00 v3` / "Not enough history yet" for data that's actually unavailable. Add a `volumePartial` analog to the existing `tvlPartial` plumbing in `page-client.tsx`'s `aggregated` payload; wire through to the chart's headline. (codex #3215163047)
- [ ] **Detail tab panels gate on decimal trust state.** The pool-detail page's tab panels (swaps history, reserves history, liquidity history, etc.) parse raw amounts with `pool.tokenNDecimals ?? 18` independently. Under an EXT query failure or `tokenDecimalsKnown=false`, those tabs render schema-default-scaled balances. Either page-level trust banner ("Token decimals unverified — values may be inaccurate") OR per-tab gating. (codex #3215163051)
- [ ] **`@claude` review (PR #372 issue comment 4415588653) follow-up sanity check.** Three findings in that review (stale `volume.ts` comment, `timeoutMs` SWR-config spread, TVL sort ascending NaN) were already auto-fixed by `/review` and `c11710c` before the @claude bot read; the follow-up acknowledged them but the architecture-fixer commit (8e87ed1) updated the comment in-line. Spot-check during the next `volume.ts` edit cycle.

## Dashboard tech debt

- [x] ~~**Resolve react-doctor suppressions on `pool/[poolId]/page.tsx`.**~~ Done: pool detail rendering was split into focused helpers, legacy/invalid pool-id canonicalization moved to the server route with `redirect()`, the client-side not-found redirect was removed in favor of the existing error state, and the direct `useSearchParams().get(...)` warnings were eliminated. Audit mode reports no diagnostics for the pool-detail client.

- [x] ~~**Resolve react-doctor `no-giant-component` suppression on `pool/[poolId]/_tabs/oracle-tab.tsx`.**~~ Done: extracted `OracleSnapshotsTable` and `OracleSnapshotRow`; audit mode reports no diagnostics for the file.

- [x] ~~**Resolve react-doctor `prefer-useReducer` suppression on `components/breach-history-panel.tsx`.**~~ Done: pagination, sort, bucket, and duration bounds now share a reducer; audit mode reports no diagnostics for the file.

## File-size watchlist (auto-generated)

_Last updated: 2026-05-01 by file-size-budget-drift-detector. Soft cap 600 lines / hard cap 1,000. See `/AGENTS.md` §"File-size budget"._

| Lines | File                                                      | Δ since last report |
| ----: | --------------------------------------------------------- | ------------------: |
|  3302 | ./indexer-envio/test/Test.ts                              |               (new) |
|  1882 | ./indexer-envio/src/rpc.ts                                |               (new) |
|  1028 | ./indexer-envio/src/handlers/fpmm.ts                      |               (new) |
|   909 | ./ui-dashboard/src/app/bridge-flows/page.tsx              |               (new) |
|   823 | ./ui-dashboard/src/components/breach-history-panel.tsx    |               (new) |
|   808 | ./ui-dashboard/src/app/api/address-labels/import/route.ts |               (new) |
|   713 | ./ui-dashboard/src/app/address-book/AddressBookClient.tsx |               (new) |
|   684 | ./indexer-envio/src/pool.ts                               |               (new) |
|   638 | ./ui-dashboard/src/components/global-pools-table.tsx      |               (new) |
|   612 | ./ui-dashboard/src/lib/fetch-all-networks.ts              |               (new) |
