import { asAddress } from "./helpers";
import { computeSwapUsdWei } from "./usd";

/** Subset of an Envio Swap event needed to derive the tx-level address fields
 *  (`caller` = tx.from, `txTo` = tx.to). Loosely typed so the v3 FPMM handler,
 *  v3 VirtualPool handler, and v2 Broker handler can all pass their concrete
 *  event without importing each other's generated types.
 *
 *  Envio's generated types declare both `transaction.from` and `transaction.to`
 *  as `string | undefined`. At runtime, `from` is always populated when
 *  `field_selection.transaction_fields` includes `"from"` (see
 *  config.multichain.*.yaml). `to` can be genuinely null on EVM for
 *  contract-creation txs, but those don't emit Mento Swap events. The
 *  empty-string fallbacks below are dead at runtime; they exist only to
 *  satisfy the looser generated type. */
export interface SwapAddressEventLike {
  transaction: { from: string | undefined; to: string | undefined };
}

/** Tx-level address fields shared by v3 `SwapEvent` (caller / txTo) and v2
 *  `BrokerSwapEvent` (caller / txTo). Centralized so both swap and broker
 *  handlers share one lowercasing policy.
 *
 *  v2 `BrokerSwapEvent` separately carries `brokerCaller` (= event.params.trader
 *  = msg.sender to Broker), which is NOT the same as `caller` for routed
 *  swaps — that's broker-specific and not part of this address triple. */
export function buildSwapAddressFields(event: SwapAddressEventLike): {
  caller: string;
  txTo: string;
} {
  return {
    caller: asAddress(event.transaction.from ?? ""),
    txTo: asAddress(event.transaction.to ?? ""),
  };
}

/** Subset of an Envio FPMM/VirtualPool Swap event we need to derive the new
 *  trader-facing fields on the v3 `SwapEvent`. */
export interface SwapEventLike extends SwapAddressEventLike {
  chainId: number;
  params: {
    amount0In: bigint;
    amount0Out: bigint;
    amount1In: bigint;
    amount1Out: bigint;
  };
}

export interface PoolLike {
  token0: string | undefined;
  token1: string | undefined;
  token0Decimals: number;
  token1Decimals: number;
}

/** The three trader-attribution fields added to v3 `SwapEvent`. Centralized so
 *  the FPMM and VirtualPool handlers share the lowercasing + USD-valuation
 *  policy. v2 `BrokerSwapEvent` doesn't reuse this helper — it computes
 *  `volumeUsdWei` from a Broker.Swap-shaped (single-leg) amount triple in the
 *  handler itself; it pulls just `{caller, txTo}` from `buildSwapAddressFields`
 *  above. */
export function buildSwapTraderFields(
  event: SwapEventLike,
  pool: PoolLike,
): { caller: string; txTo: string; volumeUsdWei: bigint } {
  return {
    ...buildSwapAddressFields(event),
    volumeUsdWei: computeSwapUsdWei({
      chainId: event.chainId,
      token0: pool.token0,
      token1: pool.token1,
      token0Decimals: pool.token0Decimals,
      token1Decimals: pool.token1Decimals,
      amount0In: event.params.amount0In,
      amount0Out: event.params.amount0Out,
      amount1In: event.params.amount1In,
      amount1Out: event.params.amount1Out,
    }),
  };
}
