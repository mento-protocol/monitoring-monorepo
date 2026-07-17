---
title: Liquity Monitoring Invariants
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
doc_type: reference
scope: indexer-envio/ui-dashboard
review_interval_days: 90
garden_lane: package-readmes-reference
---

# Liquity Monitoring Invariants

This is the current cross-layer contract for Mento's Liquity v2/Bold fork. The
historical [`PLAN-cdps-monitoring.md`](../PLAN-cdps-monitoring.md) is
non-canonical and contains superseded debt-accounting proposals; do not use it
as an implementation source without verifying current handlers and schema.

The fork is at <https://github.com/mento-protocol/bold>. Glue contracts live in
other repositories: `CDPLiquidityStrategy.sol` is in
`mento-protocol/mento-core`, and `ReserveTroveFactory.sol` is in
`mento-protocol/deployments-v2`.

## System debt accounting

The deployed ActivePool contracts do not emit
`ActivePoolBoldDebtUpdated`. Empirical Celo history for the GBPm ActivePool
contained collateral-balance and constructor events but no debt update. This
matches the upstream removal of `recordedDebtSum`; an indexer cannot repair the
absence with a more accurate event handler.

`LiquityInstance.systemDebt` therefore has two coordinated writers:

- Trove handlers call `applySystemDebtDelta` in
  `indexer-envio/src/handlers/liquity/troves.ts` to maintain the running sum of
  recorded debt for open (`active` or `zombie`) troves.
- `DefaultPoolBoldDebtUpdated`, which does emit when liquidation debt is
  redistributed, applies the DefaultPool debt delta in
  `indexer-envio/src/handlers/liquity/pools.ts`. That preserves debt which is
  still outstanding after the liquidated trove closes and before pending
  rewards are applied to surviving troves. The same delta updates the daily
  and cumulative mint/burn buckets.

Never overwrite `systemDebt` with `activePoolDebt + defaultPoolDebt`:
`activePoolDebt` cannot stay current without the missing ActivePool event. The
current invariant is open-trove recorded debt, maintained by transition deltas,
plus the independently observed DefaultPool redistribution delta.

When a handler changes trove status or debt:

1. Capture `{ status, debt }` immediately after `getOrCreateTrove`, before any
   bracket move, overwrite, or reclassified re-read.
2. Apply the mutation.
3. Call `applySystemDebtDelta(instance, prev, next)` once at the end. It is
   idempotent for no-op transitions.
4. In loop handlers, capture and apply once per row inside the loop; do not
   aggregate and then also apply per row.

`isOpenStatus` is authoritative for debt contribution. The pattern prevents
sign errors on open/closed transitions and double application.

## Redemption attribution

`CollateralRegistry.redeemCollateralRebalancing` in the fork is callable only
by the liquidity strategy but emits the same Redemption and TroveOperation
events as a user redemption. The discriminator is the transaction target:
`event.transaction.to == cdpLiquidityStrategy`, with the address resolved from
`@mento-protocol/contracts` by
`indexer-envio/src/handlers/liquity/config.ts`.

Indexer total redemption counters always increment. Rebalance counters
increment as a subset, so consumers derive user-driven values as
`total - rebalance`. Do not present total redemption volume as user activity.

## Dashboard derivations

- `systemDebt`, `systemColl`, and `spDeposits` come directly from
  `LiquityInstance`.
- The UX open-position count is derived from active plus zombie Troves because
  `activeTroveCount` excludes zombies. The list uses the trimmed `CDP_MARKETS`
  fetch (maximum 500); detail uses the `OpenTrove` branch of
  `CDP_MARKET_DETAIL` (maximum 1,000). If the indexer adds a delta-maintained
  `openTroveCount`, remove both client derivations together.
- The detail redemption split uses total and rebalance cumulative fields;
  user-driven is their difference.
- `deriveCdpHealth` currently uses shutdown, empty Stability Pool with
  outstanding debt, and SP coverage tiers. ICR/TCR percentiles remain `-1`
  sentinels until a live price feed exists; add ratio signals only when those
  values become real.

Formatting follows source-field semantics:

- `formatTokenAmount` is for unsigned balances, deposits, and totals; `-1`
  means unknown and renders as an em dash.
- `formatSignedWei` is for signed int256 deltas; `-1 wei` is a legitimate
  negative value, so only null/undefined render as unknown.

## Verifying event reality

When a production field never changes, inspect deployed logs before assuming a
handler bug. Use Blockscout or an RPC log query to count event topic hashes over
the contract's complete relevant history. If the event is absent, select a
different emitted signal, maintain a transition delta, or use a bounded
`eth_call`; changing handler code cannot manufacture a missing event.
