// ---------------------------------------------------------------------------
// Mento Broker Swap handler
//
// The Broker is the settlement layer for v2 legacy swaps that route through
// `IExchangeProvider`s such as the BiPoolManager. The v3 Router calls FPMM
// pool contracts directly and never touches the Broker, so Broker.Swap events
// give us a clean, mutually-exclusive view of v2 volume.
//
// We persist per-event `BrokerSwapEvent` rows for trader-level analytics, and
// pre-roll them into `BrokerDailySnapshot` rows keyed by
// (chainId, exchangeProvider, dayBucket) so the dashboard can render a v2
// volume series filtered to BiPoolManager swaps without scanning the full
// per-event table.
// ---------------------------------------------------------------------------

import { Broker, type BrokerSwapEvent } from "generated";
import { eventId, asAddress, asBigInt, dayBucket } from "../helpers";
import { computeSwapUsdWei } from "../usd";
import { fetchErc20Decimals } from "../rpc";

// Mento v3 Router (Router:v3.0.0). Deployed to the same address on Celo
// mainnet and Monad mainnet via deterministic deploy — see
// `mento-protocol/deployments-v2/.treb/registry.json`. The v3 Router calls
// VirtualPool wrappers, which internally route through the Broker → BiPoolManager.
// The Broker.Swap that fires inside those router-driven txs is therefore a
// sibling of a VirtualPool.Swap event in the same tx; the dashboard already
// counts the VirtualPool side as v3 volume, so we flag the Broker.Swap rows
// here so the v2 series can exclude them and avoid double-counting.
const V3_ROUTER_ADDRESS = "0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6";

// Cache decimals per (chainId, tokenAddress). Broker.Swap fires on every
// legacy swap, so an uncached RPC call per swap would dwarf indexer throughput.
// In-memory only — token decimals are immutable, so the cache is safe across
// the lifetime of the handler process.
const _decimalsCache = new Map<string, number>();

async function getTokenDecimals(
  chainId: number,
  tokenAddress: string,
): Promise<number> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = _decimalsCache.get(key);
  if (cached !== undefined) return cached;
  // `fetchErc20Decimals` consults the test mock map first, then RPC. On
  // failure we default to 18 so the rollup keeps moving instead of stalling
  // on a single misbehaving token; the cache stores the fallback so we
  // don't re-RPC every event.
  const fetched = await fetchErc20Decimals(chainId, tokenAddress);
  const safe = fetched ?? 18;
  _decimalsCache.set(key, safe);
  return safe;
}

Broker.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const exchangeProvider = asAddress(event.params.exchangeProvider);
  const tokenIn = asAddress(event.params.tokenIn);
  const tokenOut = asAddress(event.params.tokenOut);
  const txTo = asAddress(event.transaction.to ?? "");
  // Empty-string fallback above means `txTo == ""` could collide with the
  // router address comparison only if the router were the zero address —
  // it isn't. EVM contract-creation txs with `to == null` don't emit
  // Broker.Swap (no Broker entrypoint to call), so this branch shouldn't
  // fire in practice; it exists only to satisfy Envio's looser typing.
  const routedViaV3Router = txTo === V3_ROUTER_ADDRESS;

  // Decimals fetched in parallel — lookup is cached after first call per token.
  const [tokenInDecimals, tokenOutDecimals] = await Promise.all([
    getTokenDecimals(event.chainId, tokenIn),
    getTokenDecimals(event.chainId, tokenOut),
  ]);

  // computeSwapUsdWei is built around the FPMM `(token0, token1, amount{0,1}{In,Out})`
  // shape. Map the Broker's tokenIn/tokenOut into that shape: tokenIn = token0
  // with amount0In set, tokenOut = token1 with amount1Out set. The function
  // picks whichever side is USD-pegged (per USD_PEGGED_SYMBOLS) and scales it
  // to 18-decimal USD-wei, identical to the FPMM/VirtualPool path.
  const volumeUsdWei = computeSwapUsdWei({
    chainId: event.chainId,
    token0: tokenIn,
    token1: tokenOut,
    token0Decimals: tokenInDecimals,
    token1Decimals: tokenOutDecimals,
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

  // Pre-rolled day bucket — the dashboard reads BrokerDailySnapshot directly,
  // so the v2 volume chart stays under the Hasura 1000-row cap even with
  // years of history. Bucketed by `routedViaV3Router` so the chart's filter
  // `routedViaV3Router=false AND exchangeProvider=BiPoolManager` reads from
  // a single index without scanning the per-event table.
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
