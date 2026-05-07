// Mento Broker Swap handler. v3 swaps that route through VirtualPool wrappers
// also fire Broker.Swap (the wrapper transitively invokes the Broker), so we
// flag `routedViaV3Router` from `tx.to` to let the dashboard exclude those
// router-driven sibling rows from the v2 series and avoid double-count.
// VirtualPool-routed Broker.Swaps (where an external aggregator routes
// through VirtualPool — `tx.to` is the aggregator, not Router300) are
// detected separately via a Pool lookup on `event.params.trader` (which is
// `msg.sender` to Broker, == VirtualPool address in this case).

import { Broker, type BrokerSwapEvent } from "generated";
import {
  eventId,
  asAddress,
  asBigInt,
  dayBucket,
  isVirtualPool,
  makePoolId,
} from "../helpers";
import { computeSwapUsdWei } from "../usd";
import { resolveFeeTokenMeta } from "../feeToken";
import { getContractAddress } from "../contractAddresses";
import { isSystemAddress } from "../system-addresses";
import { classifyAggregator } from "../aggregators";
import { maybeHeartbeatFlushV2 } from "../leaderboardWindowFlush";

// Per-chain cache of the v3 Router address. JSON lookup once per chain is
// cheap, but a Map is cheaper still and Broker.Swap fires per swap event.
// `null` is cached too — chains without a registered Router (testnets that
// haven't been wired) skip the lookup permanently.
const routerByChain = new Map<number, string | null>();
function v3RouterAddress(chainId: number): string | null {
  const cached = routerByChain.get(chainId);
  if (cached !== undefined) return cached;
  const addr = getContractAddress(chainId, "Routerv300");
  const value = addr ? addr.toLowerCase() : null;
  routerByChain.set(chainId, value);
  return value;
}

Broker.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const exchangeProvider = asAddress(event.params.exchangeProvider);
  const trader = asAddress(event.params.trader);
  const tokenIn = asAddress(event.params.tokenIn);
  const tokenOut = asAddress(event.params.tokenOut);
  const txTo = asAddress(event.transaction.to ?? "");
  const router = v3RouterAddress(event.chainId);
  const routedViaV3Router = router !== null && txTo === router;

  // Reuses the ERC20FeeToken handler's cache + KNOWN_TOKEN_META static
  // fallback, so per-token first-hit RPC for known Mento stablecoins is free
  // and tokens already touched by an earlier ProtocolFeeTransfer don't pay
  // a second-hit RPC here either.
  const [tokenInMeta, tokenOutMeta] = await Promise.all([
    resolveFeeTokenMeta(event.chainId, tokenIn),
    resolveFeeTokenMeta(event.chainId, tokenOut),
  ]);

  // computeSwapUsdWei is built around the FPMM `(token0, token1,
  // amount{0,1}{In,Out})` shape. Broker.Swap is single-direction (only
  // amountIn flows in, only amountOut flows out), so we map tokenIn → token0
  // / amount0In and tokenOut → token1 / amount1Out, leaving the reverse legs
  // at 0n. The picker then reads the USD-pegged side off the correct token.
  const volumeUsdWei = computeSwapUsdWei({
    chainId: event.chainId,
    token0: tokenIn,
    token1: tokenOut,
    token0Decimals: tokenInMeta.decimals,
    token1Decimals: tokenOutMeta.decimals,
    amount0In: event.params.amountIn,
    amount0Out: 0n,
    amount1In: 0n,
    amount1Out: event.params.amountOut,
  });

  const swap: BrokerSwapEvent = {
    id,
    chainId: event.chainId,
    exchangeProvider,
    exchangeId: event.params.exchangeId,
    trader,
    tokenIn,
    tokenOut,
    amountIn: event.params.amountIn,
    amountOut: event.params.amountOut,
    volumeUsdWei,
    txTo,
    routedViaV3Router,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };
  context.BrokerSwapEvent.set(swap);

  // Daily rollup keyed by `(chainId, exchangeProvider, routedViaV3Router, day)`
  // so the dashboard's `routedViaV3Router=false` filter reads from a single
  // index without scanning the per-event table.
  const dayTs = dayBucket(blockTimestamp);
  const routedKey = routedViaV3Router ? "router" : "direct";
  const snapshotId = `${event.chainId}-${exchangeProvider}-${routedKey}-${dayTs}`;
  const existing = await context.BrokerDailySnapshot.get(snapshotId);
  context.BrokerDailySnapshot.set({
    id: snapshotId,
    chainId: event.chainId,
    exchangeProvider,
    routedViaV3Router,
    timestamp: dayTs,
    swapCount: (existing?.swapCount ?? 0) + 1,
    volumeUsdWei: (existing?.volumeUsdWei ?? 0n) + volumeUsdWei,
    blockNumber,
  });

  // Heartbeat the v2 leaderboard window snapshot before any of the
  // legacy-v2 producer early-returns below. Every broker.swap is a
  // heartbeat opportunity: even routed/virtual-pool swaps advance the
  // UTC-day cursor so a chain that only sees routed swaps for a stretch
  // still gets snapshots flushed at midnight rather than waiting for the
  // next direct-broker swap.
  await maybeHeartbeatFlushV2({
    context,
    chainId: event.chainId,
    blockTimestamp,
    blockNumber,
  });

  // VirtualPool-routed Broker.Swap detection. Mento's Broker emits
  // `event.params.trader = msg.sender`. When VirtualPool wraps the swap
  // (typically a third-party aggregator → VirtualPool → Broker), the
  // immediate Broker caller is the VirtualPool contract, so `trader`
  // equals a registered VirtualPool address. The v3 path already counts
  // the sibling `VirtualPool.Swap` via `applyLeaderboardSnapshots`
  // (see handlers/virtualPool.ts:186); writing v2 rollups for the same
  // tx would attribute v3 flow as legacy-v2 producer activity.
  const traderPool = await context.Pool.get(makePoolId(event.chainId, trader));
  const traderIsVirtualPool = traderPool ? isVirtualPool(traderPool) : false;

  // Legacy-v2 producer rollups. Skip when:
  //   - routedViaV3Router: this Broker.Swap is a sibling of a VirtualPool.Swap
  //     already counted by the v3 leaderboard. Including it here would
  //     double-count the same trader/aggregator across both venues.
  //   - traderIsVirtualPool: aggregator → VirtualPool → Broker — same
  //     double-count concern; `tx.to` is the aggregator router (not
  //     `Routerv300`), so the `routedViaV3Router` guard misses this path.
  //   - volumeUsdWei == 0n: USD value couldn't be derived (neither leg
  //     pegged). Same skip rule as applyLeaderboardSnapshots — writing 0n
  //     would conflate "uncomputable" with "real zero volume".
  if (routedViaV3Router || traderIsVirtualPool || volumeUsdWei === 0n) return;

  // No `pool` arg available here: BrokerSwapEvent doesn't have a Pool entity
  // backing it (v2 exchanges aren't in the `Pool` table). The static
  // contracts.json check still catches Mento internal addresses.
  const traderIsSystem = isSystemAddress(event.chainId, trader);
  const traderDayId = `${event.chainId}-${trader}-${dayTs}`;
  const existingTraderDay =
    await context.BrokerTraderDailySnapshot.get(traderDayId);
  context.BrokerTraderDailySnapshot.set({
    id: traderDayId,
    chainId: event.chainId,
    trader,
    timestamp: dayTs,
    swapCount: (existingTraderDay?.swapCount ?? 0) + 1,
    volumeUsdWei: (existingTraderDay?.volumeUsdWei ?? 0n) + volumeUsdWei,
    // Sticky-true once seen: matches TraderDailySnapshot's behaviour so a
    // sweep within a day where the address briefly didn't classify (shouldn't
    // happen for Broker swaps but mirrors v3 invariant) doesn't toggle.
    isSystemAddress: existingTraderDay
      ? existingTraderDay.isSystemAddress || traderIsSystem
      : traderIsSystem,
    lastSeenTimestamp: blockTimestamp,
  });

  // No pool address to pass — `classifyAggregator` falls back to the
  // direct-entry / system-address / unknown ladder, which is the right
  // taxonomy for v2 entry-point analysis.
  const aggregator = classifyAggregator(event.chainId, txTo);
  const aggDayId = `${event.chainId}-${aggregator}-${dayTs}`;
  const aggTraderMarkerId = `${event.chainId}-${aggregator}-${trader}-${dayTs}`;
  const existingAggTraderMarker =
    await context.BrokerAggregatorTraderDayMarker.get(aggTraderMarkerId);
  const aggTraderFirstTouch = existingAggTraderMarker === undefined;
  if (aggTraderFirstTouch) {
    context.BrokerAggregatorTraderDayMarker.set({ id: aggTraderMarkerId });
  }
  const existingAggDay =
    await context.BrokerAggregatorDailySnapshot.get(aggDayId);
  context.BrokerAggregatorDailySnapshot.set({
    id: aggDayId,
    chainId: event.chainId,
    aggregator,
    lastSeenAggregatorAddress: txTo,
    timestamp: dayTs,
    swapCount: (existingAggDay?.swapCount ?? 0) + 1,
    uniqueTraders:
      (existingAggDay?.uniqueTraders ?? 0) + (aggTraderFirstTouch ? 1 : 0),
    volumeUsdWei: (existingAggDay?.volumeUsdWei ?? 0n) + volumeUsdWei,
  });
});
