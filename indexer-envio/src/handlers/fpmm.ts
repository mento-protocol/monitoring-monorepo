// ---------------------------------------------------------------------------
// FPMM event handlers
// ---------------------------------------------------------------------------

import type { SwapEvent, TradingLimit } from "envio";
import { indexer } from "../indexer.js";
import { eventId, asAddress, asBigInt, makePoolId } from "../helpers.js";
import {
  applyTradingLimitSwap,
  buildTradingLimitEntity,
  buildTradingLimitEntityFromRpc,
  computeLimitPressures,
  computeLimitStatus,
  isKnownFeeState,
  tradingLimitConfigFromEntity,
  tradingLimitId,
  tradingLimitStateFromEntity,
} from "../tradingLimits.js";
import { tradingLimitsEffect } from "../rpc/effects.js";
import { maybePreloadPool, upsertPool, upsertSnapshot } from "../pool.js";
import { buildSwapTraderFields } from "../swap.js";
import { applyLeaderboardSnapshots } from "../leaderboardSnapshots.js";

// ---------------------------------------------------------------------------
// FPMM.Swap
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "Swap" },
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.srcAddress);
    if (await maybePreloadPool(context, poolId)) return;
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    const volume0 =
      event.params.amount0In > event.params.amount0Out
        ? event.params.amount0In
        : event.params.amount0Out;
    const volume1 =
      event.params.amount1In > event.params.amount1Out
        ? event.params.amount1In
        : event.params.amount1Out;

    // No fetchReserves RPC call needed: the FPMM contract calls _update()
    // before emitting Swap, so an UpdateReserves event with the exact post-swap
    // reserves always precedes this Swap event in the same tx. By the time this
    // handler runs, the UpdateReserves handler has already written reserves to
    // the Pool entity.
    const pool = await upsertPool({
      context,
      chainId: event.chainId,
      poolId,
      source: "fpmm_swap",
      blockNumber,
      blockTimestamp,
      txHash: event.transaction.hash,
      swapDelta: { volume0, volume1 },
    });

    await upsertSnapshot({
      context,
      pool,
      blockTimestamp,
      blockNumber,
      swapDelta: { volume0, volume1 },
    });

    // Update trading limits for FPMM pools. Once a token's limit row has
    // been seeded, derive the next state from the Swap event itself; RPC is
    // only a recovery path for missing rows or unknown fee/decimal metadata.
    if (
      pool.source &&
      pool.source.includes("fpmm") &&
      pool.token0 &&
      pool.token1
    ) {
      const updateTradingLimitFromSwap = async (
        token: string,
        amountIn: bigint,
        amountOut: bigint,
      ): Promise<TradingLimit | null> => {
        const tlId = tradingLimitId(poolId, token);
        const existing = await context.TradingLimit.get(tlId);
        const bothLimitsDisabled =
          existing !== undefined &&
          existing.limit0 === 0n &&
          existing.limit1 === 0n;
        const tokenDecimals =
          token === pool.token0
            ? pool.token0Decimals
            : token === pool.token1
              ? pool.token1Decimals
              : undefined;
        const canDerive =
          existing !== undefined &&
          (bothLimitsDisabled ||
            (tokenDecimals !== undefined &&
              pool.tokenDecimalsKnown &&
              isKnownFeeState(pool)));

        if (canDerive && existing) {
          const previousState = tradingLimitStateFromEntity(existing);
          const state =
            bothLimitsDisabled || tokenDecimals === undefined
              ? previousState
              : applyTradingLimitSwap(
                  previousState,
                  tradingLimitConfigFromEntity(existing, tokenDecimals),
                  {
                    amountIn,
                    amountOut,
                    totalFeeBps: pool.lpFee + pool.protocolFee,
                    blockTimestamp,
                  },
                );
          const tl = buildTradingLimitEntity({
            id: tlId,
            chainId: event.chainId,
            poolId,
            token,
            config: {
              limit0: existing.limit0,
              limit1: existing.limit1,
            },
            state,
            blockNumber,
            blockTimestamp,
          });
          context.TradingLimit.set(tl);
          return tl;
        }

        const limits = await context.effect(tradingLimitsEffect, {
          chainId: event.chainId,
          poolAddress: event.srcAddress,
          token,
          blockNumber,
        });
        if (!limits) return null;

        const tl = buildTradingLimitEntityFromRpc({
          id: tlId,
          chainId: event.chainId,
          poolId,
          token,
          data: limits,
          blockNumber,
          blockTimestamp,
        });
        context.TradingLimit.set(tl);
        return tl;
      };

      const [limits0, limits1] = await Promise.all([
        updateTradingLimitFromSwap(
          pool.token0,
          event.params.amount0In,
          event.params.amount0Out,
        ),
        updateTradingLimitFromSwap(
          pool.token1,
          event.params.amount1In,
          event.params.amount1Out,
        ),
      ]);

      let worstP0 = 0;
      let worstP1 = 0;

      if (limits0) {
        const { p0, p1 } = computeLimitPressures(
          limits0.netflow0,
          limits0.netflow1,
          limits0.limit0,
          limits0.limit1,
        );
        worstP0 = Math.max(worstP0, p0, p1);
      }

      if (limits1) {
        const { p0, p1 } = computeLimitPressures(
          limits1.netflow0,
          limits1.netflow1,
          limits1.limit0,
          limits1.limit1,
        );
        worstP1 = Math.max(worstP1, p0, p1);
      }

      if (limits0 || limits1) {
        // Partial state is usable. The missing row will retry RPC seed/recovery
        // on the next Swap.
        if (!limits0 || !limits1) {
          context.log.warn(
            `[FPMM.Swap] Partial trading limit update for pool ${poolId}: ` +
              `limits0=${!!limits0} limits1=${!!limits1}. ` +
              `limitStatus will reflect the available data only.`,
          );
        }
        const overallWorst = Math.max(worstP0, worstP1);
        const limitStatus = computeLimitStatus(overallWorst, 0);
        context.Pool.set({
          ...pool,
          limitStatus,
          limitPressure0: worstP0.toFixed(4),
          limitPressure1: worstP1.toFixed(4),
        });
      }
    }

    const traderFields = buildSwapTraderFields(event, pool);
    const swap: SwapEvent = {
      id,
      chainId: event.chainId,
      poolId,
      sender: asAddress(event.params.sender),
      recipient: asAddress(event.params.to),
      ...traderFields,
      amount0In: event.params.amount0In,
      amount1In: event.params.amount1In,
      amount0Out: event.params.amount0Out,
      amount1Out: event.params.amount1Out,
      txHash: event.transaction.hash,
      blockNumber,
      blockTimestamp,
    };

    context.SwapEvent.set(swap);

    await applyLeaderboardSnapshots({
      context,
      chainId: event.chainId,
      poolId,
      pool,
      caller: traderFields.caller,
      txTo: traderFields.txTo,
      volumeUsdWei: traderFields.volumeUsdWei,
      amounts: {
        amount0In: event.params.amount0In,
        amount0Out: event.params.amount0Out,
        amount1In: event.params.amount1In,
        amount1Out: event.params.amount1Out,
      },
      blockTimestamp,
      blockNumber,
    });
  },
);
