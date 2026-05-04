// Mento Broker Swap handler. v3 swaps that route through VirtualPool wrappers
// also fire Broker.Swap (the wrapper transitively invokes the Broker), so we
// flag `routedViaV3Router` from `tx.to` to let the dashboard exclude those
// router-driven sibling rows from the v2 series and avoid double-count.

import { Broker, type BrokerSwapEvent } from "generated";
import { eventId, asAddress, asBigInt, dayBucket } from "../helpers";
import { computeSwapUsdWei } from "../usd";
import { resolveFeeTokenMeta } from "../feeToken";
import { getContractAddress } from "../contractAddresses";

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
  // amount{0,1}{In,Out})` shape. Map the Broker's tokenIn/tokenOut into that
  // shape and reuse the same USD-pegged-side picker the FPMM/VirtualPool
  // handlers use.
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
    trader: asAddress(event.params.trader),
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
});
