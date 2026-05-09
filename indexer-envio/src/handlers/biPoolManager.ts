// ---------------------------------------------------------------------------
// BiPoolManager event handlers — v2 exchange registry
//
// VirtualPools wrap BiPoolManager exchanges (their `swap()` calls
// `Broker.swapIn(exchangeProvider, exchangeId, ...)`). The dashboard's
// pool-detail page renders bucket reserves, swap fee, oracle feed, etc.
// from the `BiPoolExchange` entity these handlers populate.
//
// ExchangeCreated calls `getPoolExchange` via `poolExchangeEffect` to
// backfill the full PoolConfig (spread, referenceRateFeedID, reset
// frequency, etc.) at create time. BucketsUpdated / SpreadUpdated then
// mutate fields incrementally as the contract emits update events.
// ---------------------------------------------------------------------------

import {
  BiPoolManager,
  type BiPoolExchange,
  type BucketUpdate,
  type Pool,
} from "generated";
import { eventId, asAddress, asBigInt } from "../helpers";
import { poolExchangeEffect } from "../rpc/effects";
import { lookupPricingModuleName } from "../contractAddresses";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function exchangeRowId(chainId: number, exchangeId: string): string {
  return `${chainId}-${exchangeId.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// BiPoolManager.ExchangeCreated
//
// Persist the full PoolExchange struct at create time. The event itself
// carries asset0/asset1/pricingModule but NOT spread / referenceRateFeedID /
// reset frequency / bucket targets — those would otherwise wait until later
// SpreadUpdated + BucketsUpdated events. We RPC-backfill via
// `poolExchangeEffect` (Envio dedups across the batch) so the dashboard's
// fee/feed/reset tiles aren't all "—" between create and first update.
//
// If the VirtualPool wrapper was deployed BEFORE the underlying exchange
// (rare ordering, but possible since the two registries are independent),
// the VP handler stamped `Pool.wrappedExchangeId` already — we read it back
// to set `BiPoolExchange.wrappedByPoolId` so the join works in both
// directions without an explicit `.contractRegister` orchestration.
// ---------------------------------------------------------------------------

BiPoolManager.ExchangeCreated.handler(async ({ event, context }) => {
  const id = exchangeRowId(event.chainId, event.params.exchangeId);
  const exchangeId = event.params.exchangeId.toLowerCase();
  const exchangeProvider = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // RPC backfill — `undefined` on transient failure. Caller stamps zeros for
  // the gap; the next SpreadUpdated / BucketsUpdated event still populates
  // its own fields incrementally.
  const struct = await context.effect(poolExchangeEffect, {
    chainId: event.chainId,
    exchangeProvider,
    exchangeId,
  });

  // Reverse-join: a VP deployed BEFORE this exchange would have stamped its
  // own `Pool.wrappedExchangeId` row. If we find one, populate the
  // `wrappedByPoolId` back-reference so dashboard joins work in both
  // directions. Single getWhere call — VP-first ordering is rare so the
  // search hits 0 or 1 row in practice; we still chain-filter because
  // Envio's getWhere is single-field-only.
  const wrappingPools =
    await context.Pool.getWhere.wrappedExchangeId.eq(exchangeId);
  const wrappedByPoolId = wrappingPools.find(
    (p: Pool) => p.chainId === event.chainId,
  )?.id;

  const pricingModule =
    struct?.pricingModule ?? asAddress(event.params.pricingModule);

  const row: BiPoolExchange = {
    id,
    chainId: event.chainId,
    exchangeId,
    exchangeProvider,
    asset0: struct?.asset0 ?? asAddress(event.params.asset0),
    asset1: struct?.asset1 ?? asAddress(event.params.asset1),
    pricingModule,
    pricingModuleName:
      lookupPricingModuleName(event.chainId, pricingModule) ?? undefined,
    spread: struct?.spread ?? BigInt(0),
    referenceRateFeedID: struct?.referenceRateFeedID ?? ZERO_ADDRESS,
    referenceRateResetFrequency:
      struct?.referenceRateResetFrequency ?? BigInt(0),
    minimumReports: struct?.minimumReports ?? BigInt(0),
    stablePoolResetSize: struct?.stablePoolResetSize ?? BigInt(0),
    bucket0: struct?.bucket0 ?? BigInt(0),
    bucket1: struct?.bucket1 ?? BigInt(0),
    lastBucketUpdate: struct?.lastBucketUpdate ?? BigInt(0),
    isDeprecated: false,
    wrappedByPoolId,
    createdAtBlock: blockNumber,
    createdAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };

  context.BiPoolExchange.set(row);

  // Reverse-link: if a VP wrapper deployed before this exchange, mirror the
  // feedID onto its Pool so SortedOracles handlers find it naturally.
  // Conditional gates (real feedID + matching pool exists) mirror the
  // forward-link path in virtualPool.ts to keep the two directions
  // semantically symmetric.
  if (
    wrappedByPoolId &&
    row.referenceRateFeedID &&
    row.referenceRateFeedID !== ZERO_ADDRESS
  ) {
    const pool = await context.Pool.get(wrappedByPoolId);
    if (pool && pool.referenceRateFeedID !== row.referenceRateFeedID) {
      context.Pool.set({
        ...pool,
        referenceRateFeedID: row.referenceRateFeedID,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// BiPoolManager.ExchangeDestroyed
//
// Governance has removed the exchange. The wrapper VirtualPool may still be
// deployed (it's an immutable contract) but routes nothing — UI surfaces
// the deprecation pill + amber callout based on this flag.
// ---------------------------------------------------------------------------

BiPoolManager.ExchangeDestroyed.handler(async ({ event, context }) => {
  const id = exchangeRowId(event.chainId, event.params.exchangeId);
  const existing = await context.BiPoolExchange.get(id);
  if (!existing) return; // race; ExchangeCreated was likely on a chain we don't index
  context.BiPoolExchange.set({
    ...existing,
    isDeprecated: true,
    updatedAtBlock: asBigInt(event.block.number),
    updatedAtTimestamp: asBigInt(event.block.timestamp),
  });
});

// ---------------------------------------------------------------------------
// BiPoolManager.BucketsUpdated
//
// Fires every `referenceRateResetFrequency` (typically 360s on Celo) when
// the v2 exchange recomputes its bucket sizes from SortedOracles. Two
// effects:
//   1. Append a `BucketUpdate` row for the time series (Phase 4 spot-price
//      chart consumes this).
//   2. Denormalize the latest values onto `BiPoolExchange.bucket{0,1}` +
//      `lastBucketUpdate` so the dashboard's tile reads from one row.
// ---------------------------------------------------------------------------

BiPoolManager.BucketsUpdated.handler(async ({ event, context }) => {
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const update: BucketUpdate = {
    id: eventId(event.chainId, event.block.number, event.logIndex),
    chainId: event.chainId,
    exchangeId: event.params.exchangeId.toLowerCase(),
    bucket0: event.params.bucket0,
    bucket1: event.params.bucket1,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };
  context.BucketUpdate.set(update);

  const id = exchangeRowId(event.chainId, event.params.exchangeId);
  const existing = await context.BiPoolExchange.get(id);
  if (!existing) return; // ExchangeCreated hasn't been processed yet
  context.BiPoolExchange.set({
    ...existing,
    bucket0: event.params.bucket0,
    bucket1: event.params.bucket1,
    lastBucketUpdate: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });
});

// ---------------------------------------------------------------------------
// BiPoolManager.SpreadUpdated
//
// Per-exchange swap-fee change. FixidityLib 1e24 fixed-point. The dashboard
// renders this as bps (`spread / 1e24 * 10000`).
// ---------------------------------------------------------------------------

BiPoolManager.SpreadUpdated.handler(async ({ event, context }) => {
  const id = exchangeRowId(event.chainId, event.params.exchangeId);
  const existing = await context.BiPoolExchange.get(id);
  if (!existing) return;
  context.BiPoolExchange.set({
    ...existing,
    spread: event.params.spread,
    updatedAtBlock: asBigInt(event.block.number),
    updatedAtTimestamp: asBigInt(event.block.timestamp),
  });
});
