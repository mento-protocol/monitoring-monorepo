---
title: Liquity Monitoring Invariants
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
doc_type: reference
scope: indexer-envio/ui-dashboard
review_interval_days: 90
garden_lane: package-readmes-reference
---

# Liquity Monitoring Invariants

This is the current cross-layer contract for Mento's Liquity v2/Bold fork.
Use `CDP` or `CDPs` in user-facing product copy and `Liquity` in internal
protocol, schema, and handler names.

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

## Operation ordering rollout

`TroveOperationEvent.logIndex` stores the original numeric event ordinal.
Its ID remains `eventId(chainId, blockNumber, logIndex)`. User-operation
inclusion and batch snapshot semantics remain unchanged. Numeric readers order
by `timestamp`, `blockNumber`, and `logIndex` before applying a row limit.
Legacy readers remain compatible with the additive field. The separate
`TroveLedgerEvent` contract in ADR 0074 remains unchanged.

A new field in introspection proves compatibility, not historical completeness.
Use the `deploy-indexer` workflow for candidate replay and promotion. Before
promotion, record this evidence in the rollout tracker:

1. Record the candidate SHA, resolved configuration, endpoint, and effective
   start blocks. Mainnet currently configures the three Celo TroveManagers
   (GBPm, CHFm, JPYm) from block `60664500`; the other mainnet chains have no
   configured TroveManagers. Celo Sepolia defaults to `18946570`. Verify the
   candidate configuration and environment overrides; do not move these
   starts forward to shorten replay.
2. Wait for the full configured history to replay. For every configured
   market, query its earliest and recent operation rows. Match `chainId`,
   `blockNumber`, and `logIndex` to the three numeric ID components and to
   representative canonical `TroveOperation` logs. Record the covered block
   range and row counts. Never fill absent ordinals with a default value.
3. Query a trove with same-timestamp operations using descending numeric
   `timestamp`, `blockNumber`, and `logIndex`. Confirm the server applies this
   order before `limit: 1000`. Pair limited live history with the consumer's
   reproducible Hasura cap-boundary fixture; do not claim live cap coverage
   when the selected trove has fewer than 1,001 operations.
4. After separately approved promotion, repeat the field and historical-row
   checks on the static endpoint. Keep the dashboard's old-schema query
   available for schema lag and rollback. A capped legacy response cannot
   guarantee the newest 999 operations, even after client sorting.

A caught-up status, successful deployment job, or new-event sample alone does
not satisfy the historical replay requirement. Keep rollout issue #2103 open
until producer promotion and consumer deployment evidence are complete.

Run the isolated server ordering regression with
`node ui-dashboard/scripts/test-trove-ordering-hasura.mjs`. It requires Docker
and a free local port 8080. It uses the production query strings against
Hasura v2.46.0 and disposable Postgres data. The harness generates a temporary
database password and passes it through `TROVE_ORDERING_FIXTURE_PASSWORD` to
its Docker processes. No credential setup is needed. Each of two 1,001-row histories
puts log 9/10 or block 9/10 at the 1,000-row boundary. The numeric query must
include 10 and omit 9; the legacy query does the reverse. The script removes
only its uniquely named containers after the check. It cannot target a hosted
endpoint. This fixture proves server selection under the cap, not historical
completeness of a deployed indexer.

The interim reader selects numeric ordering only after the shared schema probe
confirms `logIndex`. A missing field, pending probe, or probe failure selects
the legacy query. A failed probe has its own warning. During query changes,
the last successful response for the same trove remains visible, with its
original ordering limitation until a numeric response arrives. The separate
complete-ledger reader still disables interim polling when supported.
