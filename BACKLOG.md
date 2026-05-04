# Backlog

## Volume Leaderboard — follow-up PRs after PR 1 (indexer foundation)

PR 1 landed the schema entities + `caller`/`txTo`/`volumeUsdWei` on `SwapEvent` + handler population + `computeSwapUsdWei`. The `TraderDailySnapshot`, `TraderPoolDailySnapshot`, `AggregatorDailySnapshot`, `AggregatorTraderDayMarker`, `TraderPoolDayMarker` entities exist but no handlers write to them yet (empty tables on deploy — fine; PR 2 fills them).

Approved plan lives at `~/.claude/plans/lately-i-ve-been-thinking-expressive-pearl.md`. Sequence (each self-contained, deploy-able):

- [ ] **PR 2 — Snapshot upsert logic.** In FPMM + VirtualPool swap handlers, upsert `TraderDailySnapshot`, `TraderPoolDailySnapshot`, `AggregatorDailySnapshot`. Use marker entities to dedupe `uniquePoolsApprox` / `uniqueTradersApprox` increments. Requires:
  - `src/system-addresses.ts` — `isSystemAddress(chainId, addr)` checking `Pool.rebalancerAddress`, Mento Broker, NTT transceivers (`config/nttAddresses.json`), Yield Split (`feeToken.YIELD_SPLIT_ADDRESS`), treasury contracts. Cache resolved set per chain.
  - `src/aggregators.ts` + `config/aggregators.json` — per-chain `txTo → canonical name` lookup. Seed Squid (Celo: `0xce16F69375520ab01377ce7B88f5BA8C48F8D666`), Jumper/LI.FI (`0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`), 0x ExchangeProxy, 1inch AggregationRouter v6, Paraswap Augustus, OpenOcean Exchange, CoW GPv2Settlement. Verify each address against the docs sites listed in the plan before shipping. Monad coverage will be sparse — fine.
  - Returns `"direct"` when `txTo` is the Mento Broker, `"system"` when it's a system address, `"unknown"` otherwise (surfaces gaps for follow-up address curation).
  - Characterization tests: feed 5–10 mock `SwapEvent`s with mixed traders/pools/aggregators, assert exact upsert counts and aggregate values.
  - Schema-required, but no breaking changes — full re-sync on branch deploy to populate historical aggregates.

- [ ] **PR 3 — Leaderboard page MVP at `/leaderboard`.** Pure UI/queries, no schema. Reuses `SortableTh`, `Table`, `AddressLink`, `TimeSeriesChartCard`, `useGQL`. Volume hero + sortable table (rank / address / volume / swaps / pools / top-pool / flow badge / fees / last active) + 24h/7d/30d/All window pills + `Show system addresses` toggle + per-row expand for per-pool breakdown. Flow badge from `imbalance = |inflow - outflow| / total` over the trader's primary pool.

- [ ] **PR 4 — Concentration + cohort + dormancy tiles.** Hero-row tiles. Concentration computed client-side from top-50 `TraderDailySnapshot` rows (Hasura row cap is fine for top-50). Cohort breakdown joins `trader` against Arkham labels in Redis (`labels:global` per `reference_chrome_devtools_mcp.md` — actually that's wrong, see arkham.ts). New / dormant counts via current-vs-previous-window `TraderDailySnapshot` first-seen comparison.

- [ ] **PR 5 — Aggregator flow tab.** Pie of share + table (aggregator / volume / unique traders / swap count) + stacked time series. Direct query on `AggregatorDailySnapshot`. Surfaces `unknown` `txTo` addresses prominently so we can curate the aggregator config over time.

- [ ] **PR 6 — Per-pool top-N + outlier-swaps tabs.** Two more tabs below the main table.

- [ ] **PR 7 — Corridor map + LP-friendliness column.** Net-direction graph from `TraderPoolDailySnapshot`; `lpScore = feesPaidUsdWei / max(imbalance × volumeUsdWei, ε)` as a sortable column.

### Deferred from PR 1

- [ ] **`LeaderboardWindowSnapshot` entity for hero metrics.** Originally in the plan but deferred — dashboard can compute totals/top-N share by paginating top-50 from `TraderDailySnapshot` within Hasura's 1000-row cap. Revisit only if the cap becomes a bottleneck (>50 unique traders/day on a single chain whose tail volume materially shifts top-N share).

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
