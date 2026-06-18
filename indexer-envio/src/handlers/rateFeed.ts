// ---------------------------------------------------------------------------
// SortedOracles reporter membership -> RateFeed entity
// ---------------------------------------------------------------------------

import type { EvmOnEventContext, Pool, RateFeed } from "envio";
import { UNKNOWN_ORACLE_REPORTERS } from "../constants.js";
import { indexer } from "../indexer.js";
import {
  asAddress,
  asBigInt,
  needsOracleReporterCountRefresh,
} from "../helpers.js";
import {
  buildRateFeedEntity,
  makeRateFeedId,
  normalizeReporters,
} from "../oracleReporters.js";
import { maybePreloadPool } from "../pool.js";
import { getPoolsByFeed, updatePoolsOracleNumReporters } from "../rpc.js";
import { numReportersEffect, rateFeedOraclesEffect } from "../rpc/effects.js";

type RateFeedContext = Pick<EvmOnEventContext, "RateFeed" | "effect">;

export async function preloadRateFeed(
  context: Pick<EvmOnEventContext, "RateFeed">,
  chainId: number,
  feedAddress: string,
): Promise<void> {
  await context.RateFeed.get(makeRateFeedId(chainId, feedAddress));
}

function persistRateFeed(args: {
  context: Pick<EvmOnEventContext, "RateFeed">;
  chainId: number;
  feedAddress: string;
  reporters: ReadonlyArray<string>;
  reportersComplete: boolean;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): RateFeed {
  const entity = buildRateFeedEntity(args);
  args.context.RateFeed.set(entity);
  return entity;
}

export async function syncRateFeedFromRpc(args: {
  context: RateFeedContext;
  chainId: number;
  feedAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): Promise<RateFeed | null> {
  const reporters = await args.context.effect(rateFeedOraclesEffect, {
    chainId: args.chainId,
    rateFeedID: asAddress(args.feedAddress),
    blockNumber: args.blockNumber,
  });
  if (reporters === null) return null;
  return persistRateFeed({ ...args, reporters, reportersComplete: true });
}

export async function ensureRateFeed(args: {
  context: EvmOnEventContext;
  chainId: number;
  feedAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  poolIds?: string[];
}): Promise<RateFeed | null> {
  const existing = await args.context.RateFeed.get(
    makeRateFeedId(args.chainId, args.feedAddress),
  );
  if (existing?.reportersComplete) {
    await syncUnknownPoolReporterCounts({
      ...args,
      fallbackOracleNumReporters: existing.reporters.length,
    });
    return existing;
  }
  const synced = await syncRateFeedFromRpc(args);
  await syncPoolsReporterCountForLinkedPools({
    ...args,
    fallbackOracleNumReporters: synced?.reporters.length,
  });
  return synced ?? existing ?? null;
}

async function syncPoolsReporterCountForLinkedPools(args: {
  context: EvmOnEventContext;
  chainId: number;
  feedAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  poolIds?: string[];
  fallbackOracleNumReporters?: number | undefined;
  markAllUnknownOnMissingCount?: boolean | undefined;
}): Promise<void> {
  if (!args.poolIds || args.poolIds.length === 0) return;
  await syncPoolsReporterCountFromRpc({
    context: args.context,
    chainId: args.chainId,
    feedAddress: args.feedAddress,
    poolIds: args.poolIds,
    blockNumber: args.blockNumber,
    blockTimestamp: args.blockTimestamp,
    fallbackOracleNumReporters: args.fallbackOracleNumReporters,
    markAllUnknownOnMissingCount: args.markAllUnknownOnMissingCount,
  });
}

async function syncUnknownPoolReporterCounts(args: {
  context: EvmOnEventContext;
  chainId: number;
  feedAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  poolIds?: string[];
  fallbackOracleNumReporters?: number | undefined;
}): Promise<void> {
  if (args.poolIds && args.poolIds.length > 0) {
    const pools = await Promise.all(
      args.poolIds.map((poolId) => args.context.Pool.get(poolId)),
    );
    if (
      pools.some((pool: Pool | undefined) =>
        pool ? needsOracleReporterCountRefresh(pool) : false,
      )
    ) {
      await syncPoolsReporterCountForLinkedPools(args);
    }
  }
}

async function applyReporterFallback(args: {
  context: RateFeedContext;
  chainId: number;
  feedAddress: string;
  reporterAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  action: "add" | "remove";
}): Promise<RateFeed> {
  const existing = await args.context.RateFeed.get(
    makeRateFeedId(args.chainId, args.feedAddress),
  );
  const current = normalizeReporters(existing?.reporters ?? []);
  const reporter = asAddress(args.reporterAddress);
  const reportersComplete = existing?.reportersComplete ?? false;
  const reporters =
    args.action === "add"
      ? normalizeReporters([...current, reporter])
      : current.filter((address) => address !== reporter);
  return persistRateFeed({ ...args, reporters, reportersComplete });
}

async function syncOrApplyReporterDelta(args: {
  context: RateFeedContext;
  chainId: number;
  feedAddress: string;
  reporterAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  action: "add" | "remove";
}): Promise<RateFeed> {
  const synced = await syncRateFeedFromRpc(args);
  if (synced) return synced;
  return applyReporterFallback(args);
}

export async function syncPoolsReporterCountFromRpc(args: {
  context: EvmOnEventContext;
  chainId: number;
  feedAddress: string;
  poolIds: string[];
  blockNumber: bigint;
  blockTimestamp: bigint;
  fallbackOracleNumReporters?: number | undefined;
  markAllUnknownOnMissingCount?: boolean | undefined;
}): Promise<void> {
  const rpcOracleNumReporters = await args.context.effect(numReportersEffect, {
    chainId: args.chainId,
    rateFeedID: args.feedAddress,
    blockNumber: args.blockNumber,
  });
  const oracleNumReporters =
    rpcOracleNumReporters ?? args.fallbackOracleNumReporters;
  if (oracleNumReporters === undefined) {
    const poolIdsNeedingRefresh = args.markAllUnknownOnMissingCount
      ? args.poolIds
      : await poolIdsWithStaleOrUnknownReporterCounts(
          args.context,
          args.poolIds,
        );
    await updatePoolsOracleNumReporters({
      context: args.context,
      poolIds: poolIdsNeedingRefresh,
      oracleNumReporters: UNKNOWN_ORACLE_REPORTERS,
      blockNumber: args.blockNumber,
      blockTimestamp: args.blockTimestamp,
    });
    return;
  }
  await updatePoolsOracleNumReporters({
    context: args.context,
    poolIds: args.poolIds,
    oracleNumReporters,
    blockNumber: args.blockNumber,
    blockTimestamp: args.blockTimestamp,
  });
}

async function poolIdsWithStaleOrUnknownReporterCounts(
  context: EvmOnEventContext,
  poolIds: string[],
): Promise<string[]> {
  const pools = await Promise.all(
    poolIds.map((poolId) => context.Pool.get(poolId)),
  );
  return pools.flatMap((pool) =>
    pool && needsOracleReporterCountRefresh(pool) ? [pool.id] : [],
  );
}

indexer.onEvent(
  { contract: "SortedOracles", event: "OracleAdded" },
  async ({ event, context }) => {
    const feedAddress = asAddress(event.params.token);
    const reporterAddress = asAddress(event.params.oracleAddress);
    const poolIds = await getPoolsByFeed(context, event.chainId, feedAddress);
    if (context.isPreload) {
      await Promise.all([
        preloadRateFeed(context, event.chainId, feedAddress),
        maybePreloadPool(context, poolIds),
      ]);
      return;
    }
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const rateFeed = await syncOrApplyReporterDelta({
      context,
      chainId: event.chainId,
      feedAddress,
      reporterAddress,
      blockNumber,
      blockTimestamp,
      action: "add",
    });
    await syncPoolsReporterCountFromRpc({
      context,
      chainId: event.chainId,
      feedAddress,
      poolIds,
      blockNumber,
      blockTimestamp,
      fallbackOracleNumReporters: rateFeed.reportersComplete
        ? rateFeed.reporters.length
        : undefined,
      markAllUnknownOnMissingCount: true,
    });
  },
);

indexer.onEvent(
  { contract: "SortedOracles", event: "OracleRemoved" },
  async ({ event, context }) => {
    const feedAddress = asAddress(event.params.token);
    const reporterAddress = asAddress(event.params.oracleAddress);
    const poolIds = await getPoolsByFeed(context, event.chainId, feedAddress);
    if (context.isPreload) {
      await Promise.all([
        preloadRateFeed(context, event.chainId, feedAddress),
        maybePreloadPool(context, poolIds),
      ]);
      return;
    }
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const rateFeed = await syncOrApplyReporterDelta({
      context,
      chainId: event.chainId,
      feedAddress,
      reporterAddress,
      blockNumber,
      blockTimestamp,
      action: "remove",
    });
    await syncPoolsReporterCountFromRpc({
      context,
      chainId: event.chainId,
      feedAddress,
      poolIds,
      blockNumber,
      blockTimestamp,
      fallbackOracleNumReporters: rateFeed.reportersComplete
        ? rateFeed.reporters.length
        : undefined,
      markAllUnknownOnMissingCount: true,
    });
  },
);
