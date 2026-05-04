import { asAddress } from "./helpers";
import { computeSwapUsdWei } from "./usd";

/** Subset of an Envio FPMM/VirtualPool Swap event we need to derive the new
 *  trader-facing fields on `SwapEvent`. Loosely typed so both handlers can pass
 *  their concrete event without importing each other's generated types.
 *
 *  Envio's generated types declare both `transaction.from` and `transaction.to`
 *  as `string | undefined`. At runtime, `from` is always populated when
 *  `field_selection.transaction_fields` includes `"from"` (see
 *  config.multichain.*.yaml — this PR ensures both `from` and `to` are loaded).
 *  `to` can be genuinely null on EVM for contract-creation txs, but those
 *  don't emit Mento Swap events. The empty-string fallbacks below are dead at
 *  runtime; they exist only to satisfy the looser generated type. */
export interface SwapEventLike {
  chainId: number;
  transaction: { from: string | undefined; to: string | undefined };
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

/** The three trader-attribution fields added to `SwapEvent`. Centralized so both
 *  swap handlers share the lowercasing + USD-valuation policy. */
export function buildSwapTraderFields(
  event: SwapEventLike,
  pool: PoolLike,
): { caller: string; txTo: string; volumeUsdWei: bigint } {
  return {
    caller: asAddress(event.transaction.from ?? ""),
    txTo: asAddress(event.transaction.to ?? ""),
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
