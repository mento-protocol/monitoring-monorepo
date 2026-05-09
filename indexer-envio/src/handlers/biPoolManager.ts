// ---------------------------------------------------------------------------
// BiPoolManager event handlers — v2 exchange registry
//
// VirtualPools wrap BiPoolManager exchanges (their `swap()` calls
// `Broker.swapIn(exchangeProvider, exchangeId, ...)`). The dashboard's
// pool-detail page renders bucket reserves, swap fee, oracle feed, etc.
// from the `BiPoolExchange` entity these handlers populate.
//
// Phase 2 wiring (this file): contract is registered + events are
// recognized. ExchangeCreated handler stubs out the entity with what the
// event provides directly; the full PoolConfig (spread, referenceRateFeedID,
// reset frequency, …) lands in a follow-up commit that adds the
// `getPoolExchange` RPC effect. BucketsUpdated / SpreadUpdated / Exchange-
// Destroyed handlers carry real logic from this commit.
// ---------------------------------------------------------------------------

import {
  BiPoolManager,
  type BiPoolExchange,
  type BucketUpdate,
} from "generated";
import { eventId, asAddress, asBigInt } from "../helpers";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function exchangeRowId(chainId: number, exchangeId: string): string {
  return `${chainId}-${exchangeId.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// BiPoolManager.ExchangeCreated
//
// Minimal v1: persist what the event provides. Spread / referenceRateFeedID
// / reset frequency / bucket targets land via SpreadUpdated + BucketsUpdated
// + a follow-up RPC backfill. Until then the field is zero/empty — the
// dashboard renders "—" for unknown values, same as the API-route path did.
// ---------------------------------------------------------------------------

BiPoolManager.ExchangeCreated.handler(async ({ event, context }) => {
  const id = exchangeRowId(event.chainId, event.params.exchangeId);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const row: BiPoolExchange = {
    id,
    chainId: event.chainId,
    exchangeId: event.params.exchangeId.toLowerCase(),
    exchangeProvider: asAddress(event.srcAddress),
    asset0: asAddress(event.params.asset0),
    asset1: asAddress(event.params.asset1),
    pricingModule: asAddress(event.params.pricingModule),
    pricingModuleName: undefined,
    spread: BigInt(0),
    referenceRateFeedID: ZERO_ADDRESS,
    referenceRateResetFrequency: BigInt(0),
    minimumReports: BigInt(0),
    stablePoolResetSize: BigInt(0),
    bucket0: BigInt(0),
    bucket1: BigInt(0),
    lastBucketUpdate: BigInt(0),
    isDeprecated: false,
    wrappedByPoolId: undefined,
    createdAtBlock: blockNumber,
    createdAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };

  context.BiPoolExchange.set(row);
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
