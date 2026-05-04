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
