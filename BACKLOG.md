# Backlog

## Refactor — long files (next candidates after PR #263)

PR #263 split `ui-dashboard/src/app/pool/[poolId]/page.tsx` from 2,831 → 470 lines. Same playbook (characterization tests first, then per-module extraction, snapshot-diff verification per commit) applies to the rest. Ranked by impact × tractability:

### Tier S — clear wins (>1k lines, dense logic)

- [ ] **`indexer-envio/src/rpc.ts` — 1,882 lines.** Indexer RPC adapter (per-method handlers + retry/dispatch). No browser-level tests cover it; characterization tests for retry + dispatch are non-optional before splitting. Highest cognitive-load file in the repo.
- [ ] **`indexer-envio/src/handlers/fpmm.ts` — 1,022 lines.** Split per event type (Swap / Rebalance / LiquidityChange / etc.) — mirrors the pool-page tab split.

### Tier A — UI page refactors (need characterization tests first)

- [ ] **`ui-dashboard/src/app/bridge-flows/page.tsx` — 909 lines.** Blocker: no page-level test. Write lazy-mount + table-render pins first.
- [ ] **`ui-dashboard/src/components/breach-history-panel.tsx` — 823 lines.** Blocker: no test. Filter composition + duration parser are clean seams.
- [ ] **`ui-dashboard/src/app/address-book/AddressBookClient.tsx` — 713 lines.** Stub test only. Extract CSV/JSON import logic + `<AddressTableRow/>` (189 lines inline).

### Tier B — lib/utility splits (low-risk, no UI)

- [ ] **`ui-dashboard/src/lib/queries.ts` — 810 lines.** GraphQL constants only. Split by domain (pools / events / breaches / snapshots / config). Zero behavior risk; biggest win is grep-ability.
- [ ] **`ui-dashboard/src/app/api/address-labels/import/route.ts` — 808 lines.** Split CSV parser, JSON parser, validators, batching out of the handler.
- [ ] **`ui-dashboard/src/lib/fetch-all-networks.ts` — 610 lines.** Already covered by hook tests; pagination + error gating + Sentry throttling are reusable.

### Tier C — defer (only if related work touches them)

- `indexer-envio/src/pool.ts` (677), `handlers/wormhole/nttManager.ts` (578) — split if working on indexer
- `ui-dashboard/src/components/global-pools-table.tsx` (638) — has 511 lines of tests; low-risk to split, but cognitive load isn't bad
- `lib/rebalance-check.ts` (506), `lib/homepage-og.ts` (494), `breakers.ts` (486) — under the threshold; defer

## Cosmetic follow-ups deferred from PR #263

Pre-existing behavior carried over verbatim from the monolithic pool page; flagged by claude[bot] review but kept out of scope of the refactor PR.

- [ ] `_tabs/reserves-tab.tsx` — `<Th align="right">Total (USD)</Th>` is rendered unconditionally even when `showUsd` is false (cells then show `—`). Mirror the `LpsTab` pattern: `{showUsd && <Th align="right">Total (USD)</Th>}` plus matching cell wrap.
- [ ] `_tabs/swaps-tab.tsx` — cumulative-stats IIFE block. Replace `{(() => { const last = snapshots[0]; if (!last) return null; return (...); })()}` with `const lastSnapshot = snapshots[0]` above the return + `{lastSnapshot && (...)}`.
