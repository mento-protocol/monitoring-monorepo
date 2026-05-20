// Mento Broker Swap handler. v3 swaps that route through VirtualPool wrappers
// also fire Broker.Swap (the wrapper transitively invokes the Broker), so we
// flag `routedViaV3Router` from `tx.to` + `brokerCaller` to let the dashboard
// exclude those router-driven sibling rows from the v2 series and avoid
// double-count.
// VirtualPool-routed Broker.Swaps (where an external aggregator routes
// through VirtualPool — `tx.to` is the aggregator, not Router300) are
// detected separately via a Pool lookup on `event.params.trader` (which is
// `msg.sender` to Broker, == VirtualPool address in this case).

import type { BrokerSwapEvent, EvmOnEventContext, Pool } from "envio";
import { indexer } from "../indexer.js";
import {
  eventId,
  asAddress,
  asBigInt,
  dayBucket,
  isVirtualPool,
  makePoolId,
} from "../helpers.js";
import { computeSwapUsdWei } from "../usd.js";
import { UNKNOWN_FEE_TOKEN_META } from "../feeToken.js";
import { getContractAddress } from "../contractAddresses.js";
import { isSystemAddress } from "../system-addresses.js";
import { classifyAggregator } from "../aggregators.js";
import { maybeHeartbeatFlushV2 } from "../leaderboardWindowFlush.js";
import { buildSwapAddressFields } from "../swap.js";
import { selfHealWrappedExchangeId } from "../pool.js";
import { feeTokenMetaEffect } from "../rpc/effects.js";

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

function contractAddress(chainId: number, name: string): string | null {
  return getContractAddress(chainId, name)?.toLowerCase() ?? null;
}

function classifyBrokerEntryPoint(chainId: number, txTo: string): string {
  const lower = txTo.toLowerCase();
  if (lower === contractAddress(chainId, "Broker")) return "broker";
  if (
    lower === contractAddress(chainId, "Router") ||
    lower === contractAddress(chainId, "Routerv300")
  ) {
    return "mento-router-v2";
  }
  return classifyAggregator(chainId, txTo);
}

async function maybeHealBrokerCallerPool(
  context: EvmOnEventContext,
  pool: Pool | undefined,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<Pool | undefined> {
  if (!pool) return undefined;
  return selfHealWrappedExchangeId(context, pool, blockNumber, blockTimestamp);
}

async function preloadBrokerSwapInputs(args: {
  context: EvmOnEventContext;
  exchangeSnapshotId: string;
  brokerCallerPoolId: string;
}): Promise<void> {
  await Promise.all([
    args.context.BrokerExchangeDailySnapshot.get(args.exchangeSnapshotId),
    args.context.Pool.get(args.brokerCallerPoolId),
  ]);
}

async function writeBrokerProducerRollups(args: {
  context: EvmOnEventContext;
  chainId: number;
  caller: string;
  txTo: string;
  dayTs: bigint;
  blockTimestamp: bigint;
  volumeUsdWei: bigint;
}) {
  const {
    context,
    chainId,
    caller,
    txTo,
    dayTs,
    blockTimestamp,
    volumeUsdWei,
  } = args;
  const callerIsSystem = isSystemAddress(chainId, caller);
  const callerDayId = `${chainId}-${caller}-${dayTs}`;
  const aggregator = classifyBrokerEntryPoint(chainId, txTo);
  const aggDayId = `${chainId}-${aggregator}-${dayTs}`;
  const aggCallerMarkerId = `${chainId}-${aggregator}-${caller}-${dayTs}`;
  const [existingCallerDay, existingAggCallerMarker, existingAggDay] =
    await Promise.all([
      context.BrokerTraderDailySnapshot.get(callerDayId),
      context.BrokerAggregatorTraderDayMarker.get(aggCallerMarkerId),
      context.BrokerAggregatorDailySnapshot.get(aggDayId),
    ]);
  context.BrokerTraderDailySnapshot.set({
    id: callerDayId,
    chainId,
    caller,
    timestamp: dayTs,
    swapCount: (existingCallerDay?.swapCount ?? 0) + 1,
    volumeUsdWei: (existingCallerDay?.volumeUsdWei ?? 0n) + volumeUsdWei,
    isSystemAddress: existingCallerDay
      ? existingCallerDay.isSystemAddress || callerIsSystem
      : callerIsSystem,
    lastSeenTimestamp: blockTimestamp,
  });

  const aggCallerFirstTouch = existingAggCallerMarker === undefined;
  if (aggCallerFirstTouch) {
    context.BrokerAggregatorTraderDayMarker.set({ id: aggCallerMarkerId });
  }
  context.BrokerAggregatorDailySnapshot.set({
    id: aggDayId,
    chainId,
    aggregator,
    lastSeenAggregatorAddress: txTo,
    timestamp: dayTs,
    swapCount: (existingAggDay?.swapCount ?? 0) + 1,
    uniqueTraders:
      (existingAggDay?.uniqueTraders ?? 0) + (aggCallerFirstTouch ? 1 : 0),
    volumeUsdWei: (existingAggDay?.volumeUsdWei ?? 0n) + volumeUsdWei,
  });
}

indexer.onEvent(
  { contract: "Broker", event: "Swap" },
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const exchangeProvider = asAddress(event.params.exchangeProvider);
    const exchangeId = event.params.exchangeId.toLowerCase();
    // `event.params.trader` from Broker.Swap = `msg.sender` to Broker. For
    // routed swaps this is a router/aggregator/wrapper contract; for direct
    // trades from a UI/SDK this equals tx.from. We track it as `brokerCaller`
    // on the entity to keep that semantics explicit, and use `caller` (tx.from)
    // for signer-EOA-level attribution in the rollups.
    const brokerCaller = asAddress(event.params.trader);
    const { caller, txTo } = buildSwapAddressFields(event);
    const tokenIn = asAddress(event.params.tokenIn);
    const tokenOut = asAddress(event.params.tokenOut);
    const router = v3RouterAddress(event.chainId);
    const txToV3Router = router !== null && txTo === router;

    // Reuses the ERC20FeeToken handler's cache + KNOWN_TOKEN_META static
    // fallback, so per-token first-hit RPC for known Mento stablecoins is free
    // and tokens already touched by an earlier ProtocolFeeTransfer don't pay
    // a second-hit RPC here either.
    const [tokenInMetaResult, tokenOutMetaResult] = await Promise.all([
      context.effect(feeTokenMetaEffect, {
        chainId: event.chainId,
        tokenAddress: tokenIn,
      }),
      context.effect(feeTokenMetaEffect, {
        chainId: event.chainId,
        tokenAddress: tokenOut,
      }),
    ]);
    const tokenInMeta = tokenInMetaResult ?? UNKNOWN_FEE_TOKEN_META;
    const tokenOutMeta = tokenOutMetaResult ?? UNKNOWN_FEE_TOKEN_META;
    const dayTs = dayBucket(blockTimestamp);
    const exchangeSnapshotId = `${event.chainId}-${exchangeProvider}-${exchangeId}-${dayTs}`;
    const brokerCallerPoolId = makePoolId(event.chainId, brokerCaller);

    if (context.isPreload)
      return preloadBrokerSwapInputs({
        context,
        exchangeSnapshotId,
        brokerCallerPoolId,
      });

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

    let brokerCallerPool: Awaited<ReturnType<typeof context.Pool.get>>;
    const [existingExchangeSnapshot, initialBrokerCallerPool] =
      await Promise.all([
        context.BrokerExchangeDailySnapshot.get(exchangeSnapshotId),
        context.Pool.get(brokerCallerPoolId),
      ]);
    brokerCallerPool = initialBrokerCallerPool;
    context.BrokerExchangeDailySnapshot.set({
      id: exchangeSnapshotId,
      chainId: event.chainId,
      exchangeId,
      exchangeProvider,
      timestamp: dayTs,
      swapCount: (existingExchangeSnapshot?.swapCount ?? 0) + 1,
      volumeUsdWei:
        (existingExchangeSnapshot?.volumeUsdWei ?? 0n) + volumeUsdWei,
      blockNumber,
    });

    // VirtualPool-routed Broker.Swap detection. Mento's Broker emits
    // `event.params.trader = msg.sender` — we track this as `brokerCaller` on
    // the entity. When VirtualPool wraps the swap (typically a third-party
    // aggregator → VirtualPool → Broker), the immediate Broker caller is the
    // VirtualPool contract, so `brokerCaller` equals a registered VirtualPool
    // address. The v3 path already counts the sibling `VirtualPool.Swap` via
    // `applyLeaderboardSnapshots` (see handlers/virtualPool.ts:186); writing
    // v2 rollups for the same tx would attribute v3 flow as legacy-v2
    // producer activity.
    //
    // Detection runs BEFORE BrokerDailySnapshot is written so the daily
    // volume series (consumed by the dashboard's v2 volume-over-time chart
    // via `routedViaV3Router=false` filter) excludes these double-counted
    // swaps too — the original schema flag `routedViaV3Router` only catches
    // the Router → VirtualPool path, not the aggregator → VirtualPool path.
    // Round 3 #6: pre-warm VP classification. Pre-start_block VPs whose
    // first event is `VirtualPool.UpdateReserves` (the inner step of a
    // VP-routed swap) get a Pool row with source `fpmm_update_reserves`
    // and no `wrappedExchangeId` yet. Broker.Swap fires next in the same
    // tx, BEFORE VirtualPool.Swap's own heal runs, so a source-only check
    // would misclassify the VP-routed swap as legacy v2 and write the
    // double-counting rollup. Run the heal here so isVirtualPool sees the
    // bytecode-confirmed `wrappedExchangeId`. Idempotent + effect-cached
    // — VirtualPool.Swap's later upsertPool call hits the same cache.
    // Delegate fully to `selfHealWrappedExchangeId` — its internal gate
    // (round 7 codex #3) checks both token presence AND exchange-row
    // seed before short-circuiting.
    brokerCallerPool = await maybeHealBrokerCallerPool(
      context,
      brokerCallerPool,
      blockNumber,
      blockTimestamp,
    );
    const brokerCallerIsVirtualPool = brokerCallerPool
      ? isVirtualPool(brokerCallerPool)
      : false;
    const routedViaV3Router = txToV3Router && brokerCallerIsVirtualPool;

    const swap: BrokerSwapEvent = {
      id,
      chainId: event.chainId,
      exchangeProvider,
      exchangeId,
      brokerCaller,
      caller,
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

    // Heartbeat the v2 leaderboard window snapshot before any of the
    // legacy-v2 early-returns below. Every broker.swap is a heartbeat
    // opportunity: even routed/virtual-pool swaps advance the UTC-day
    // cursor so a chain that only sees routed swaps for a stretch still
    // gets snapshots flushed at midnight rather than waiting for the next
    // direct-broker swap.
    await maybeHeartbeatFlushV2({
      context,
      chainId: event.chainId,
      blockTimestamp,
      blockNumber,
    });

    // Daily rollup for legacy-v2 volume keyed by
    // `(chainId, exchangeProvider, day)`. Skip the write entirely for
    // VirtualPool-routed swaps — the v3 VirtualPool.Swap sibling already
    // accounts for them in its own snapshot table; including them here would
    // inflate the legacy-v2 volume series.
    if (!brokerCallerIsVirtualPool) {
      const snapshotId = `${event.chainId}-${exchangeProvider}-direct-${dayTs}`;
      const existing = await context.BrokerDailySnapshot.get(snapshotId);
      context.BrokerDailySnapshot.set({
        id: snapshotId,
        chainId: event.chainId,
        exchangeProvider,
        routedViaV3Router: false,
        timestamp: dayTs,
        swapCount: (existing?.swapCount ?? 0) + 1,
        volumeUsdWei: (existing?.volumeUsdWei ?? 0n) + volumeUsdWei,
        blockNumber,
      });
    }

    // Legacy-v2 producer rollups. Skip when:
    //   - routedViaV3Router: this Broker.Swap is a sibling of a VirtualPool.Swap
    //     already counted by the v3 leaderboard. Including it here would
    //     double-count the same caller/aggregator across both venues. The
    //     tx.to Router check alone is not enough: legacy v2 Router calls also
    //     enter at that address but call Broker directly instead of through a
    //     VirtualPool.
    //   - brokerCallerIsVirtualPool: aggregator → VirtualPool → Broker — same
    //     double-count concern; `tx.to` is the aggregator router (not
    //     `Routerv300`), so the `routedViaV3Router` guard misses this path.
    //   - volumeUsdWei == 0n: USD value couldn't be derived (neither leg
    //     pegged). Same skip rule as applyLeaderboardSnapshots — writing 0n
    //     would conflate "uncomputable" with "real zero volume".
    if (routedViaV3Router || brokerCallerIsVirtualPool || volumeUsdWei === 0n) {
      return;
    }

    // Rollups key on `caller` (tx.from / signer EOA), mirroring v3's
    // TraderDailySnapshot semantics. No `pool` arg available here:
    // BrokerSwapEvent doesn't have a Pool entity backing it (v2 exchanges
    // aren't in the `Pool` table). The static contracts.json check still
    // catches Mento internal addresses.
    //
    // We deliberately check ONLY `caller` (signer EOA), not `brokerCaller`.
    // Mento's `system-addresses` set includes both true protocol-internal
    // contracts (Reserve, MigrationMultisig, ReserveLiquidityStrategy) AND
    // user-facing routers that wrap normal swaps (MentoRouter v1/v2,
    // Routerv300). OR-checking `brokerCaller` would correctly catch a
    // hypothetical Safe-initiated treasury swap (where the Safe is the
    // brokerCaller and the owner EOA is the caller) — but it would also
    // wrongly hide every user who routes through MentoRouter, since the
    // Router contract is in the same flat system-addresses list. The
    // false-positive cost (hiding real users) outweighs the missed-Safe
    // edge case; if the Safe-treasury path becomes load-bearing we can
    // either split system-addresses into "internal" vs "router" tiers, or
    // register the Safe owner EOAs in system-addresses directly. For now
    // signer-EOA matching is the safer rule — codex flagged the OR-form
    // as a P1 false-positive on PR #363.
    await writeBrokerProducerRollups({
      context,
      chainId: event.chainId,
      caller,
      txTo,
      dayTs,
      blockTimestamp,
      volumeUsdWei,
    });
  },
);
