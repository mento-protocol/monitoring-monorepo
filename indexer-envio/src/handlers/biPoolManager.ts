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
import type { HandlerContext } from "generated/src/Types";
import { eventId, asAddress, asBigInt } from "../helpers";
import { ZERO_ADDRESS } from "../constants";
import { mirrorFeedIdToPool } from "../pool";
import { poolExchangeEffect } from "../rpc/effects";
import { lookupPricingModuleName } from "../contractAddresses";

function exchangeRowId(chainId: number, exchangeId: string): string {
  return `${chainId}-${exchangeId.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Self-heal: BiPoolExchange backfill for ExchangeCreated events that fired
// pre-start_block. The active Mento v2 exchanges on Celo were registered
// in 2022; the indexer's start_block currently begins much later. Without
// this, no BiPoolExchange row exists for any pre-existing exchange and the
// dashboard's pool-detail panel renders "—" forever even though the VP is
// active.
//
// Strategy: in every BucketsUpdated / SpreadUpdated handler, if the row is
// missing, RPC-backfill via `poolExchangeEffect` and seed the row before
// applying the event-driven mutation. BucketsUpdated fires every 360s on
// every active exchange, so the seed lands within ~6 minutes of catch-up.
// On RPC failure the function returns null and the caller skips the
// mutation; the next BucketsUpdated retries.
// ---------------------------------------------------------------------------

async function ensureBiPoolExchange(
  context: HandlerContext,
  chainId: number,
  exchangeId: string,
  exchangeProvider: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<BiPoolExchange | null> {
  const id = exchangeRowId(chainId, exchangeId);
  const existing = await context.BiPoolExchange.get(id);
  if (existing) {
    let current: BiPoolExchange = existing;
    // Stub-config retry: `ExchangeCreated` writes a partial row when
    // `poolExchangeEffect` fails, leaving config sentinels at zero.
    // Detect via `referenceRateFeedID === ZERO_ADDRESS` only — that's
    // the most reliable single signal because no event-driven write
    // in this handler ever touches the feedID (only RPC backfill
    // fills it). Spread + buckets can be incrementally filled by
    // `SpreadUpdated` / `BucketsUpdated` between ExchangeCreated
    // and the first retry, so keying on those would let the stub
    // hide as "partially filled" and never retry the rest.
    if (current.referenceRateFeedID === ZERO_ADDRESS) {
      const struct = await context.effect(poolExchangeEffect, {
        chainId,
        exchangeProvider,
        exchangeId,
      });
      if (struct && struct.pricingModule !== ZERO_ADDRESS) {
        // Bucket fields: only fill from struct when no BucketsUpdated has
        // landed yet (`lastBucketUpdate === 0n`). Once a BucketsUpdated
        // event has moved them, those values are more authoritative than
        // the struct's `latest`-block read. Without this, a stub retry
        // triggered first by `SpreadUpdated` (before any BucketsUpdated)
        // would leave buckets at zero even though the struct had real
        // values, and the panel would render an active exchange with
        // 0 buckets / 1970 reset.
        const bucketsAlreadyMoved = current.lastBucketUpdate > BigInt(0);
        current = {
          ...current,
          // Preserve fields that event-driven writes own; only fill the
          // still-stubbed ones from the RPC struct.
          referenceRateFeedID: struct.referenceRateFeedID,
          referenceRateResetFrequency: struct.referenceRateResetFrequency,
          minimumReports: struct.minimumReports,
          stablePoolResetSize: struct.stablePoolResetSize,
          pricingModule: struct.pricingModule,
          pricingModuleName:
            lookupPricingModuleName(chainId, struct.pricingModule) ?? undefined,
          // spread: only fill if still at the stub default — don't
          // clobber a SpreadUpdated value with the struct's older spread.
          spread: current.spread === BigInt(0) ? struct.spread : current.spread,
          // buckets: fill from struct only when no BucketsUpdated has
          // landed; otherwise preserve event-driven values.
          bucket0: bucketsAlreadyMoved ? current.bucket0 : struct.bucket0,
          bucket1: bucketsAlreadyMoved ? current.bucket1 : struct.bucket1,
          lastBucketUpdate: bucketsAlreadyMoved
            ? current.lastBucketUpdate
            : struct.lastBucketUpdate,
          updatedAtBlock: blockNumber,
          updatedAtTimestamp: blockTimestamp,
        };
        context.BiPoolExchange.set(current);
        // If the wrapping VP is already linked (exchange-first → VP-link
        // → bucket retry path), the stub fill JUST recovered the feedID
        // — mirror it now so SortedOracles wakes the VP without waiting
        // for the next BucketsUpdated event.
        if (current.wrappedByPoolId) {
          await mirrorFeedIdToPool(
            context,
            current.wrappedByPoolId,
            current.referenceRateFeedID,
            blockNumber,
            blockTimestamp,
          );
        }
      }
    }
    // The seed-time `Pool.getWhere.wrappedExchangeId.eq` may have returned
    // 0 results because no VP had self-healed yet. Re-attempt the link
    // here so a VP that heals AFTER the row is seeded still gets joined.
    if (!current.wrappedByPoolId) {
      const wrappingPools =
        await context.Pool.getWhere.wrappedExchangeId.eq(exchangeId);
      const wrappedByPoolId = wrappingPools.find(
        (p: Pool) => p.chainId === chainId,
      )?.id;
      if (wrappedByPoolId) {
        current = {
          ...current,
          wrappedByPoolId,
          updatedAtBlock: blockNumber,
          updatedAtTimestamp: blockTimestamp,
        };
        context.BiPoolExchange.set(current);
        await mirrorFeedIdToPool(
          context,
          wrappedByPoolId,
          current.referenceRateFeedID,
          blockNumber,
          blockTimestamp,
        );
      }
    }
    return current;
  }

  const struct = await context.effect(poolExchangeEffect, {
    chainId,
    exchangeProvider,
    exchangeId,
  });
  // RPC failure (or seed RPC actually returned a deprecated zero struct).
  // The caller skips the mutation; next event re-fetches.
  if (!struct) return null;
  // All-zero struct = exchange was destroyed / never existed. Don't seed
  // — the next BucketsUpdated wouldn't fire anyway, and a SpreadUpdated
  // on a zombie exchange shouldn't materialize an empty row.
  if (
    struct.bucket0 === BigInt(0) &&
    struct.bucket1 === BigInt(0) &&
    struct.lastBucketUpdate === BigInt(0) &&
    struct.pricingModule === ZERO_ADDRESS
  ) {
    return null;
  }

  // Look up an existing wrapping VP (forward link from VirtualPoolDeployed)
  // so the seeded row knows which Pool wraps it.
  const wrappingPools =
    await context.Pool.getWhere.wrappedExchangeId.eq(exchangeId);
  const wrappedByPoolId = wrappingPools.find(
    (p: Pool) => p.chainId === chainId,
  )?.id;

  const row: BiPoolExchange = {
    id,
    chainId,
    exchangeId,
    exchangeProvider,
    asset0: struct.asset0,
    asset1: struct.asset1,
    pricingModule: struct.pricingModule,
    pricingModuleName:
      lookupPricingModuleName(chainId, struct.pricingModule) ?? undefined,
    spread: struct.spread,
    referenceRateFeedID: struct.referenceRateFeedID,
    referenceRateResetFrequency: struct.referenceRateResetFrequency,
    minimumReports: struct.minimumReports,
    stablePoolResetSize: struct.stablePoolResetSize,
    bucket0: struct.bucket0,
    bucket1: struct.bucket1,
    lastBucketUpdate: struct.lastBucketUpdate,
    isDeprecated: false,
    wrappedByPoolId,
    // Seed time = first event observed; ExchangeCreated block is unknown.
    createdAtBlock: blockNumber,
    createdAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  context.BiPoolExchange.set(row);

  if (wrappedByPoolId) {
    await mirrorFeedIdToPool(
      context,
      wrappedByPoolId,
      row.referenceRateFeedID,
      blockNumber,
      blockTimestamp,
    );
  }
  return row;
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

  // Preload phase: warm entity reads only. With `preload_handlers: true`
  // the same event runs twice (preload + processing); without this guard
  // the non-cached `poolExchangeEffect` would fire on both passes,
  // doubling RPC pressure exactly during the transient-RPC window the
  // backfill is trying to survive.
  if (context.isPreload) {
    await Promise.all([
      context.BiPoolExchange.get(id),
      context.Pool.getWhere.wrappedExchangeId.eq(exchangeId),
    ]);
    return;
  }

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

  if (wrappedByPoolId) {
    await mirrorFeedIdToPool(
      context,
      wrappedByPoolId,
      row.referenceRateFeedID,
      blockNumber,
      blockTimestamp,
    );
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
  const exchangeId = event.params.exchangeId.toLowerCase();
  const exchangeProvider = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Preload: warm both entity reads we'll need in the processing pass.
  if (context.isPreload) {
    await Promise.all([
      context.BiPoolExchange.get(id),
      context.Pool.getWhere.wrappedExchangeId.eq(exchangeId),
    ]);
    return;
  }

  const existing = await context.BiPoolExchange.get(id);

  // Re-run the wrapping-VP lookup at destroy time. If the row was seeded
  // before any VP self-healed (or never seeded at all), `wrappedByPoolId`
  // is null — and since the dashboard's `POOL_V2_EXCHANGE` query keys on
  // `wrappedByPoolId`, an unlinked deprecated row stays invisible to
  // operators forever (no later BiPoolManager events fire on a destroyed
  // exchange to retry the link).
  const wrappingPools =
    await context.Pool.getWhere.wrappedExchangeId.eq(exchangeId);
  const linkedPoolId = wrappingPools.find(
    (p: Pool) => p.chainId === event.chainId,
  )?.id;
  // Existing row's wrappedByPoolId wins over the fresh getWhere if both
  // resolve — the existing one is already a successful link, fresh
  // lookup is a fallback.
  const wrappedByPoolId = existing?.wrappedByPoolId ?? linkedPoolId;

  if (existing) {
    context.BiPoolExchange.set({
      ...existing,
      isDeprecated: true,
      wrappedByPoolId,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    });
    return;
  }

  // Seed-from-destroy: ExchangeCreated fired pre-start_block (or on a
  // chain we don't index) and Destroyed is the first BiPoolManager event
  // we see. Without this branch the deprecated state is lost forever.
  // The `ExchangeDestroyed` ABI carries asset0/asset1/pricingModule —
  // enough to materialize a deprecated row with config sentinels for
  // the still-missing fields. `getPoolExchange` reverts on a destroyed
  // exchange so RPC backfill isn't an option for those.
  const pricingModule = asAddress(event.params.pricingModule);
  const seeded: BiPoolExchange = {
    id,
    chainId: event.chainId,
    exchangeId,
    exchangeProvider,
    asset0: asAddress(event.params.asset0),
    asset1: asAddress(event.params.asset1),
    pricingModule,
    pricingModuleName:
      lookupPricingModuleName(event.chainId, pricingModule) ?? undefined,
    spread: BigInt(0),
    referenceRateFeedID: ZERO_ADDRESS,
    referenceRateResetFrequency: BigInt(0),
    minimumReports: BigInt(0),
    stablePoolResetSize: BigInt(0),
    bucket0: BigInt(0),
    bucket1: BigInt(0),
    lastBucketUpdate: BigInt(0),
    isDeprecated: true,
    wrappedByPoolId,
    createdAtBlock: blockNumber,
    createdAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  context.BiPoolExchange.set(seeded);
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

  // Preload phase: warm the BiPoolExchange entity read; skip the RPC
  // backfill in `ensureBiPoolExchange` (cache:false `poolExchangeEffect`
  // would fire twice without this gate, see ExchangeCreated handler).
  if (context.isPreload) {
    await context.BiPoolExchange.get(
      exchangeRowId(event.chainId, event.params.exchangeId),
    );
    return;
  }

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

  // Self-heal: pre-start_block ExchangeCreated events never fired, so this
  // is the first time we're seeing the exchange in our index. ensureRow
  // RPC-backfills via getPoolExchange + persists; on RPC failure returns
  // null and we skip the snapshot mutation, retrying on the next event.
  const existing = await ensureBiPoolExchange(
    context,
    event.chainId,
    event.params.exchangeId.toLowerCase(),
    asAddress(event.srcAddress),
    blockNumber,
    blockTimestamp,
  );
  if (!existing) return;
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
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  // Preload phase: warm BiPoolExchange entity read; skip the RPC
  // backfill in ensureBiPoolExchange (see ExchangeCreated handler).
  if (context.isPreload) {
    await context.BiPoolExchange.get(
      exchangeRowId(event.chainId, event.params.exchangeId),
    );
    return;
  }
  // Self-heal — see BucketsUpdated for the full rationale.
  const existing = await ensureBiPoolExchange(
    context,
    event.chainId,
    event.params.exchangeId.toLowerCase(),
    asAddress(event.srcAddress),
    blockNumber,
    blockTimestamp,
  );
  if (!existing) return;
  context.BiPoolExchange.set({
    ...existing,
    spread: event.params.spread,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });
});
