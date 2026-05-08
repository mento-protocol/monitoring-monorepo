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

- `cluster-7dc08ec28f299c06` (Celo, deployer `0x7dc08ec28f299c062d2941de1f9cfb741df8f022`) — 4 contracts, ~$235k cumulative volume.

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
- [ ] **Date-range filter on `getWhere.chainId.eq` during heartbeat flush.** `flushV{2,3}LeaderboardWindowSnapshots` loads ALL historical `TraderDailySnapshot` / `BrokerTraderDailySnapshot` rows for the chain on each flush, then filters in memory. Fine at current scale (~21k rows / 100ms on Celo's all-window); needs a date-range filter (or a per-day partitioning entity) at 10× scale. Source: claude[bot] review on PR #328 (finding 4).
- [x] ~~**Stale-snapshot detection when a chain has no events for ≥1 UTC day.**~~ Done: `mergeHeroSnapshot` now drops snapshot rows whose `snapshotDay` is older than yesterday's UTC midnight and returns the affected `chainId`s in `staleChains`. The leaderboard page renders an amber `role="status"` banner above the hero tiles naming each silent chain (via `chainLabel`). Filter applies under both `showSystem` branches. Boundary tests in `leaderboard.test.ts` cover today / yesterday / older snapshots. Source: claude[bot] review on PR #328 (finding 3).

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

- [ ] `_lib/address-book-rows.test.ts` — `buildContractRows`, `buildCustomRows`, `filterRows`, and `unknownChainNetwork` are currently covered only through the 38 characterization tests in `AddressBookClient.test.tsx`. A dedicated unit-test file for the lib module (especially `unknownChainNetwork`'s fallback sentinel values) would tighten the safety net independently of the UI.

## Cosmetic follow-ups deferred from PR #263

Pre-existing behavior carried over verbatim from the monolithic pool page; flagged by claude[bot] review but kept out of scope of the refactor PR.

- [ ] `_tabs/reserves-tab.tsx` — `<Th align="right">Total (USD)</Th>` is rendered unconditionally even when `showUsd` is false (cells then show `—`). Mirror the `LpsTab` pattern: `{showUsd && <Th align="right">Total (USD)</Th>}` plus matching cell wrap.
- [ ] `_tabs/swaps-tab.tsx` — cumulative-stats IIFE block. Replace `{(() => { const last = snapshots[0]; if (!last) return null; return (...); })()}` with `const lastSnapshot = snapshots[0]` above the return + `{lastSnapshot && (...)}`.

## Follow-ups deferred from PR #304 (per-pool revenue leaderboard)

- [ ] **Component-level tests for `RevenueByPoolTable`.** Sort transitions, label fallback (truncated address when `poolLabels` lookup misses), partial-data render when one chain has `feesError`, and the `≈`-prefix per-window scoping. Both `/review` (65 conf) and Cursor flagged the gap. Helpers (`aggregateProtocolFeesByPool`) are well-covered; the stateful UI is not.
- [x] ~~**Tests for `useProtocolFees` orchestration.**~~ Done: `src/hooks/__tests__/use-protocol-fees.test.ts` — 13 tests covering happy path, fees/rates/labels rejection, all-fail, hasura URL guard, and per-chain isolation.
- [x] ~~**URL-persisted sort state on `RevenueByPoolTable` and `GlobalPoolsTable`.**~~ Done in this PR: new `useTableSort<K>` hook in `lib/use-table-sort.ts` reads sort key + direction from search params via `useSearchParams` and writes back via `useRouter().replace()`. Strips params when state matches defaults; canonicalizes malformed/partial URL params on mount so the address bar always describes the rendered state. Per-table `paramPrefix` (`leaderboard`, `pools`) keeps params from colliding. Smoke integration tests on both real consumers verify the wiring (URL state → `aria-sort`).
- [x] ~~**Per-chain truncation flag on the leaderboard.**~~ Done in PR #306: `buildRows` derives per-window flags from each chain's `isTruncated` AND the oldest returned transfer's timestamp vs each window's lower bound, so a window is flagged only when the cap actually clipped data inside it. Each `FeeColumn` carries a `truncatedField` symmetric to `unpricedField`; `approxAnnotation(row, column)` checks both per column. Tests cover all (truncated × unpriced) combinations and per-window cases (oldest-older-than-30d → only All-time; oldest-inside-30d → 30d + All-time; etc.).

## Follow-ups deferred from PR #330 (forensic reports — Phase 1)

- [x] ~~**Backup parity for forensic reports.**~~ Done in this PR: extended `/api/address-labels/backup` to load both labels and the full `reports` hash via a new `getAllReports()` HGETALL helper, and embed both under `addresses` + `reports` in the same daily Blob snapshot (one cron, one blob — keeps the team-plan slot count steady and avoids partial restores). `AddressLabelsSnapshot.reports?` is back-compat optional so old snapshots still parse. The `/api/address-labels/import` snapshot path now also restores reports verbatim (preserves the snapshot's `version` / `createdAt` / `updatedAt`) via a new `importReports()` HSET helper, with `isSnapshot` recognising the new `reports` key. Restore enforces the same content invariants as the live editor (`validateSnapshotReports` mirrors `sanitizeReportInput` — non-empty body, body ≤ 50KB, title ≤ 200). Manual `/api/address-labels/export` now also includes `reports` so an export-then-reimport cycle preserves both halves.
- [ ] **Server-side restore-from-Blob endpoint.** Import body cap is currently 4MB (fits ~80 max-size reports + labels), which is comfortable headroom against current usage but a hard ceiling. Vercel's 4.5MB serverless body limit means raising it further isn't viable. If usage ever pushes past 4MB, a daily backup would become unrestorable through `/api/address-labels/import`. The right fix is a `POST /api/address-labels/restore?pathname=...` endpoint that pulls the snapshot directly from the Vercel Blob store (no body upload) and runs the same `handleSnapshot` pipeline. Tracked here because the failure mode is rare and not yet observed.
- [ ] **Report-only addresses need a UI surface.** The address-book page builds rows from `contractRows + customRows`. An address with a forensic report but no label has no row, so the report is unreachable through the UI after the modal closes. Options: (a) add a `/address-book/reports` index page listing every address with a report, or (b) include report-only rows in the main address book (deduplicated against contract + custom rows). Flagged by Codex on PR #330.
- [x] **Address labels: drop chain/global scope (mirror reports).** Done in PR #332 — labels now live in a single `labels` hash keyed by lowercase address. Migration runs via `POST /api/address-labels/migrate-flat` (cron-secret or session) which snapshots the legacy `labels:{chainId}` + `labels:global` hashes to Vercel Blob, merges into the new flat key (union tags, prefer most-recently-updated fields, earliest createdAt), verifies, then deletes the legacy keys. Idempotent.
- [ ] **Drop the legacy dual-read in `getLabels` / `getLabel`.** PR #332 ships a transition path where `getLabels()` and `getLabel(address)` read the flat hash plus every legacy `labels:{chainId}` / `labels:global` so the UI doesn't blank out between the deploy and the manual `POST /api/address-labels/migrate-flat` call. After production has run the migration and confirmed the response shows `legacyDropped: true`, remove the legacy half of the read in `ui-dashboard/src/lib/address-labels.ts` and delete the migration route + tests. Keep `KNOWN_LEGACY_KEYS` until the legacy half is gone, then drop that too.

## Follow-ups deferred from PR #335 (sign-in callback preservation)

- [ ] **Live `href` on the global "Sign in" link for cmd/ctrl/middle-click.** PR #335 keeps the unmodified-click path on a live URL by recomputing `callbackUrl` from `window.location` inside the click handler, but the anchor `href` itself stays frozen at the render-time `useSearchParams()` snapshot — so cmd-click / middle-click / "open link in new tab" sends OAuth through the stale callback. Acceptable today: cmd-click is a deliberate "open in a side tab" gesture, the original tab still has the live URL state, and shared session means returning to the source tab works. To fix properly: monkeypatch `history.pushState`/`replaceState` once at the app root to dispatch a `'locationchange'` custom event, and have `AuthStatus` (and any future consumers) re-derive `href` via a `useSyncExternalStore` (or equivalent) that listens to `popstate` + `locationchange`. Cursor flagged this on PR #335 review.

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
