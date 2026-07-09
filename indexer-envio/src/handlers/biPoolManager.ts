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

import type { BiPoolExchange, BucketUpdate, EvmOnEventContext } from "envio";
import { indexer } from "../indexer.js";
import { eventId, asAddress, asBigInt } from "../helpers.js";
import { ZERO_ADDRESS } from "../constants.js";
import {
  mirrorTokensAndDecimalsToPool,
  mirrorVirtualPoolOracleConfig,
} from "../pool.js";
import { poolExchangeEffect } from "../rpc/effects.js";
import { lookupPricingModuleName } from "../contractAddresses.js";
import type { PoolExchangeStruct } from "../rpc/biPoolManager.js";

function exchangeRowId(chainId: number, exchangeId: string): string {
  return `${chainId}-${exchangeId.toLowerCase()}`;
}

async function findWrappedPool(
  context: EvmOnEventContext,
  chainId: number,
  exchangeId: string,
): Promise<string | undefined> {
  const wrappingPools = await context.Pool.getWhere({
    chainId: { _eq: chainId },
    wrappedExchangeId: { _eq: exchangeId },
  });
  return wrappingPools[0]?.id;
}

async function preloadBiPoolExchangeLink(
  context: EvmOnEventContext,
  chainId: number,
  exchangeId: string,
): Promise<void> {
  const existing = await context.BiPoolExchange.get(
    exchangeRowId(chainId, exchangeId),
  );
  if (
    !existing ||
    (!existing.wrappedByPoolId && !existing.wrappedByPoolIdChecked)
  ) {
    await context.Pool.getWhere({ wrappedExchangeId: { _eq: exchangeId } });
  }
}

async function refreshExistingBiPoolExchange(
  context: EvmOnEventContext,
  args: {
    current: BiPoolExchange;
    chainId: number;
    exchangeId: string;
    exchangeProvider: string;
    blockNumber: bigint;
    blockTimestamp: bigint;
  },
): Promise<BiPoolExchange> {
  let { current } = args;
  const { chainId, exchangeId, exchangeProvider, blockNumber, blockTimestamp } =
    args;
  if (current.referenceRateFeedID === ZERO_ADDRESS) {
    const struct = await context.effect(poolExchangeEffect, {
      chainId,
      exchangeProvider,
      exchangeId,
      blockNumber,
    });
    if (struct && struct.pricingModule !== ZERO_ADDRESS) {
      const bucketsAlreadyMoved = current.lastBucketUpdate > BigInt(0);
      current = {
        ...current,
        referenceRateFeedID: struct.referenceRateFeedID,
        referenceRateResetFrequency: struct.referenceRateResetFrequency,
        minimumReports: struct.minimumReports,
        stablePoolResetSize: struct.stablePoolResetSize,
        pricingModule: struct.pricingModule,
        pricingModuleName:
          lookupPricingModuleName(chainId, struct.pricingModule) ?? undefined,
        spread: current.spread === BigInt(0) ? struct.spread : current.spread,
        bucket0: bucketsAlreadyMoved ? current.bucket0 : struct.bucket0,
        bucket1: bucketsAlreadyMoved ? current.bucket1 : struct.bucket1,
        lastBucketUpdate: bucketsAlreadyMoved
          ? current.lastBucketUpdate
          : struct.lastBucketUpdate,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      context.BiPoolExchange.set(current);
    }
  }
  if (!current.wrappedByPoolId && !current.wrappedByPoolIdChecked) {
    current = {
      ...current,
      wrappedByPoolId: await findWrappedPool(context, chainId, exchangeId),
      wrappedByPoolIdChecked: true,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    };
    context.BiPoolExchange.set(current);
  }
  if (current.wrappedByPoolId) {
    await mirrorVirtualPoolOracleConfig(context, {
      poolId: current.wrappedByPoolId,
      feedId: current.referenceRateFeedID,
      freshnessWindow: current.referenceRateResetFrequency,
      blockNumber,
      blockTimestamp,
    });
    await mirrorTokensAndDecimalsToPool(context, {
      poolId: current.wrappedByPoolId,
      asset0: current.asset0,
      asset1: current.asset1,
      blockNumber,
      blockTimestamp,
    });
  }
  return current;
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
  context: EvmOnEventContext,
  chainId: number,
  exchangeId: string,
  exchangeProvider: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<BiPoolExchange | null> {
  const id = exchangeRowId(chainId, exchangeId);
  const existing = await context.BiPoolExchange.get(id);
  if (existing) {
    return refreshExistingBiPoolExchange(context, {
      current: existing,
      chainId,
      exchangeId,
      exchangeProvider,
      blockNumber,
      blockTimestamp,
    });
  }

  const struct = await context.effect(poolExchangeEffect, {
    chainId,
    exchangeProvider,
    exchangeId,
    blockNumber,
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

  const wrappedByPoolId = await findWrappedPool(context, chainId, exchangeId);

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
    wrappedByPoolIdChecked: true,
    // Seed time = first event observed; ExchangeCreated block is unknown.
    createdAtBlock: blockNumber,
    createdAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  context.BiPoolExchange.set(row);

  if (wrappedByPoolId) {
    await mirrorVirtualPoolOracleConfig(context, {
      poolId: wrappedByPoolId,
      feedId: row.referenceRateFeedID,
      freshnessWindow: row.referenceRateResetFrequency,
      blockNumber,
      blockTimestamp,
    });
    // Same reverse-link backfill as the link-after-seed branch above —
    // a VP that self-healed before this row was seeded carries empty
    // tokens / default decimals; mirror them from the row we just
    // materialized.
    await mirrorTokensAndDecimalsToPool(context, {
      poolId: wrappedByPoolId,
      asset0: row.asset0,
      asset1: row.asset1,
      blockNumber,
      blockTimestamp,
    });
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

function makeExchangeCreatedRow({
  id,
  chainId,
  exchangeId,
  exchangeProvider,
  params,
  struct,
  wrappedByPoolId,
  blockNumber,
  blockTimestamp,
}: {
  id: string;
  chainId: number;
  exchangeId: string;
  exchangeProvider: string;
  params: {
    asset0: string;
    asset1: string;
    pricingModule: string;
  };
  struct: PoolExchangeStruct | null;
  wrappedByPoolId: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): BiPoolExchange {
  const pricingModule =
    struct?.pricingModule ?? asAddress(params.pricingModule);
  return {
    id,
    chainId,
    exchangeId,
    exchangeProvider,
    asset0: struct?.asset0 ?? asAddress(params.asset0),
    asset1: struct?.asset1 ?? asAddress(params.asset1),
    pricingModule,
    pricingModuleName:
      lookupPricingModuleName(chainId, pricingModule) ?? undefined,
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
    wrappedByPoolIdChecked: true,
    createdAtBlock: blockNumber,
    createdAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
}

async function syncWrappedPoolFromCreatedExchange(
  context: EvmOnEventContext,
  row: BiPoolExchange,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  if (!row.wrappedByPoolId) return;
  await mirrorVirtualPoolOracleConfig(context, {
    poolId: row.wrappedByPoolId,
    feedId: row.referenceRateFeedID,
    freshnessWindow: row.referenceRateResetFrequency,
    blockNumber,
    blockTimestamp,
  });
  // VP-deployed-before-exchange ordering: the wrapping VP self-healed
  // (or set its forward link via `VirtualPoolDeployed`) before this
  // exchange row existed. Its `selfHealWrappedExchangeId` couldn't
  // mirror tokens because the row wasn't there yet — backfill them
  // now that we just persisted asset0/asset1.
  await mirrorTokensAndDecimalsToPool(context, {
    poolId: row.wrappedByPoolId,
    asset0: row.asset0,
    asset1: row.asset1,
    blockNumber,
    blockTimestamp,
  });
}

indexer.onEvent(
  { contract: "BiPoolManager", event: "ExchangeCreated" },
  async ({ event, context }) => {
    const id = exchangeRowId(event.chainId, event.params.exchangeId);
    const exchangeId = event.params.exchangeId.toLowerCase();
    const exchangeProvider = asAddress(event.srcAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    // Preload phase: warm entity reads only. With v3 preload optimization,
    // the same event runs twice (preload + processing); without this guard
    // the non-cached `poolExchangeEffect` would fire on both passes,
    // doubling RPC pressure exactly during the transient-RPC window the
    // backfill is trying to survive.
    if (context.isPreload) {
      await preloadBiPoolExchangeLink(context, event.chainId, exchangeId);
      return;
    }

    // RPC backfill — `null` on transient failure. Caller stamps zeros for
    // the gap; the next SpreadUpdated / BucketsUpdated event still populates
    // its own fields incrementally.
    const struct = await context.effect(poolExchangeEffect, {
      chainId: event.chainId,
      exchangeProvider,
      exchangeId,
      blockNumber,
    });

    // Reverse-join a VP that stamped `Pool.wrappedExchangeId` before this exchange.
    const wrappedByPoolId = await findWrappedPool(
      context,
      event.chainId,
      exchangeId,
    );

    const row = makeExchangeCreatedRow({
      id,
      chainId: event.chainId,
      exchangeId,
      exchangeProvider,
      params: event.params,
      struct,
      wrappedByPoolId: wrappedByPoolId ?? "",
      blockNumber,
      blockTimestamp,
    });

    context.BiPoolExchange.set(row);
    await syncWrappedPoolFromCreatedExchange(
      context,
      row,
      blockNumber,
      blockTimestamp,
    );
  },
);

// ---------------------------------------------------------------------------
// BiPoolManager.ExchangeDestroyed
//
// Governance has removed the exchange. The wrapper VirtualPool may still be
// deployed (it's an immutable contract) but routes nothing — UI surfaces
// the deprecation pill + amber callout based on this flag.
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BiPoolManager", event: "ExchangeDestroyed" },
  async ({ event, context }) => {
    const id = exchangeRowId(event.chainId, event.params.exchangeId);
    const exchangeId = event.params.exchangeId.toLowerCase();
    const exchangeProvider = asAddress(event.srcAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    // Preload: warm both entity reads we'll need in the processing pass.
    if (context.isPreload) {
      await preloadBiPoolExchangeLink(context, event.chainId, exchangeId);
      return;
    }

    const existing = await context.BiPoolExchange.get(id);

    // Retry the wrapping-VP lookup at destroy time so late-seeded deprecated
    // rows remain queryable by `wrappedByPoolId`.
    const linkedPoolId =
      existing?.wrappedByPoolId || existing?.wrappedByPoolIdChecked
        ? undefined
        : await findWrappedPool(context, event.chainId, exchangeId);
    // Existing row's wrappedByPoolId wins over the fresh getWhere if both
    // resolve — the existing one is already a successful link, fresh
    // lookup is a fallback.
    const wrappedByPoolId = existing?.wrappedByPoolId ?? linkedPoolId;

    if (existing) {
      context.BiPoolExchange.set({
        ...existing,
        isDeprecated: true,
        wrappedByPoolId,
        wrappedByPoolIdChecked: true,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      });
      // Round 5 codex: mirror tokens + decimals to the wrapping Pool when
      // the destroy completes the link. Existing row carries asset0/asset1.
      // Helper is idempotent — fast-bails when both tokens are present.
      if (wrappedByPoolId) {
        await mirrorTokensAndDecimalsToPool(context, {
          poolId: wrappedByPoolId,
          asset0: existing.asset0,
          asset1: existing.asset1,
          blockNumber,
          blockTimestamp,
        });
      }
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
      wrappedByPoolIdChecked: true,
      createdAtBlock: blockNumber,
      createdAtTimestamp: blockTimestamp,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    };
    context.BiPoolExchange.set(seeded);
    // Round 5 codex: seed-from-destroy completes the reverse-link too.
    // If a VP self-healed before this row existed, no later
    // BucketsUpdated/SpreadUpdated events will fire on the destroyed
    // exchange, so this is the LAST chance to mirror tokens + decimals.
    if (wrappedByPoolId) {
      await mirrorTokensAndDecimalsToPool(context, {
        poolId: wrappedByPoolId,
        asset0: seeded.asset0,
        asset1: seeded.asset1,
        blockNumber,
        blockTimestamp,
      });
    }
  },
);

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

indexer.onEvent(
  { contract: "BiPoolManager", event: "BucketsUpdated" },
  async ({ event, context }) => {
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const exchangeId = event.params.exchangeId.toLowerCase();

    // Preload phase: warm BOTH entity reads `ensureBiPoolExchange` may use
    // in the processing pass — the BiPoolExchange row itself AND the
    // `Pool.getWhere.wrappedExchangeId` lookup that backfills
    // `wrappedByPoolId` for orphan rows. Without warming the second one, a
    // VP linked in the same processing batch could be missed by the cold
    // getWhere read. The cache:false `poolExchangeEffect` is intentionally
    // NOT called here (RPC stays in processing only).
    if (context.isPreload) {
      await preloadBiPoolExchangeLink(context, event.chainId, exchangeId);
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
  },
);

// ---------------------------------------------------------------------------
// BiPoolManager.SpreadUpdated
//
// Per-exchange swap-fee change. FixidityLib 1e24 fixed-point. The dashboard
// renders this as bps (`spread / 1e24 * 10000`).
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "BiPoolManager", event: "SpreadUpdated" },
  async ({ event, context }) => {
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const exchangeId = event.params.exchangeId.toLowerCase();
    // Preload: warm both reads ensureBiPoolExchange may use — see
    // BucketsUpdated for the full rationale.
    if (context.isPreload) {
      await preloadBiPoolExchangeLink(context, event.chainId, exchangeId);
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
  },
);
