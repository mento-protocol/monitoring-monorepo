# Backlog

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
- [ ] **Tests for `useProtocolFees` orchestration.** Three-query parallel fetch (rates/fees/labels), rates-only failure → `feesError` promotion, labels-only failure → non-fatal silent degrade.
- [ ] **URL-persisted sort state on `RevenueByPoolTable`.** Sort key + direction live in `useState` only; refresh / back-forward / share drops the chosen ordering. Cursor flagged this as the "stateful-table URL-state" regression pattern. Pattern is generic — likely applies to `GlobalPoolsTable` too if it doesn't already have it. Use `useSearchParams` + `useRouter().replace()` to round-trip.
- [ ] **Per-chain truncation flag on the leaderboard's All-time column.** Today the page-level `feesApprox` is no longer passed to `RevenueByPoolTable` (Cursor finding: too coarse for per-row); the row-level `unpriced*` flags handle pricing-quality. But chain-level truncation (`isTruncated` on `ProtocolFeeSummary`) isn't surfaced on the All-time column. Either compute per-chain `isTruncated` and apply only to that chain's rows' All-time cell, or wait for the pre-rolled snapshot follow-up that eliminates the cap entirely.

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
