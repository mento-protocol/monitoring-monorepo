// ---------------------------------------------------------------------------
// SortedOracles reporter membership -> RateFeed entity
// ---------------------------------------------------------------------------

import type { EvmOnEventContext, RateFeed } from "envio";
import { indexer } from "../indexer.js";
import { asAddress, asBigInt } from "../helpers.js";
import {
  buildRateFeedEntity,
  makeRateFeedId,
  normalizeReporters,
} from "../oracleReporters.js";
import { rateFeedOraclesEffect } from "../rpc/effects.js";

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
  context: RateFeedContext;
  chainId: number;
  feedAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): Promise<RateFeed | null> {
  const existing = await args.context.RateFeed.get(
    makeRateFeedId(args.chainId, args.feedAddress),
  );
  if (existing?.reportersComplete) return existing;
  return (await syncRateFeedFromRpc(args)) ?? existing ?? null;
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
}): Promise<void> {
  const synced = await syncRateFeedFromRpc(args);
  if (synced) return;
  await applyReporterFallback(args);
}

indexer.onEvent(
  { contract: "SortedOracles", event: "OracleAdded" },
  async ({ event, context }) => {
    const feedAddress = asAddress(event.params.token);
    const reporterAddress = asAddress(event.params.oracleAddress);
    if (context.isPreload) {
      await preloadRateFeed(context, event.chainId, feedAddress);
      return;
    }
    await syncOrApplyReporterDelta({
      context,
      chainId: event.chainId,
      feedAddress,
      reporterAddress,
      blockNumber: asBigInt(event.block.number),
      blockTimestamp: asBigInt(event.block.timestamp),
      action: "add",
    });
  },
);

indexer.onEvent(
  { contract: "SortedOracles", event: "OracleRemoved" },
  async ({ event, context }) => {
    const feedAddress = asAddress(event.params.token);
    const reporterAddress = asAddress(event.params.oracleAddress);
    if (context.isPreload) {
      await preloadRateFeed(context, event.chainId, feedAddress);
      return;
    }
    await syncOrApplyReporterDelta({
      context,
      chainId: event.chainId,
      feedAddress,
      reporterAddress,
      blockNumber: asBigInt(event.block.number),
      blockTimestamp: asBigInt(event.block.timestamp),
      action: "remove",
    });
  },
);
