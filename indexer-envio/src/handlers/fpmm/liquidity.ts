// ---------------------------------------------------------------------------
// FPMM.Mint and FPMM.Burn handlers
// ---------------------------------------------------------------------------

import type { LiquidityEvent } from "envio";
import { indexer } from "../../indexer.js";
import { eventId, asAddress, asBigInt, makePoolId } from "../../helpers.js";
import { maybePreloadPool, upsertPool, upsertSnapshot } from "../../pool.js";

// ---------------------------------------------------------------------------
// FPMM.Mint
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "Mint" },
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.srcAddress);
    if (await maybePreloadPool(context, poolId)) return;
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    const pool = await upsertPool({
      context,
      chainId: event.chainId,
      poolId,
      source: "fpmm_mint",
      blockNumber,
      blockTimestamp,
      txHash: event.transaction.hash,
    });

    await upsertSnapshot({
      context,
      pool,
      blockTimestamp,
      blockNumber,
      mintDelta: true,
    });

    const liquidityEvent: LiquidityEvent = {
      id,
      chainId: event.chainId,
      poolId,
      kind: "MINT",
      sender: asAddress(event.params.sender),
      recipient: asAddress(event.params.to),
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      liquidity: event.params.liquidity,
      txHash: event.transaction.hash,
      blockNumber,
      blockTimestamp,
    };

    context.LiquidityEvent.set(liquidityEvent);
  },
);

// ---------------------------------------------------------------------------
// FPMM.Burn
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "Burn" },
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.srcAddress);
    if (await maybePreloadPool(context, poolId)) return;
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    const pool = await upsertPool({
      context,
      chainId: event.chainId,
      poolId,
      source: "fpmm_burn",
      blockNumber,
      blockTimestamp,
      txHash: event.transaction.hash,
    });

    await upsertSnapshot({
      context,
      pool,
      blockTimestamp,
      blockNumber,
      burnDelta: true,
    });

    const liquidityEvent: LiquidityEvent = {
      id,
      chainId: event.chainId,
      poolId,
      kind: "BURN",
      sender: asAddress(event.params.sender),
      recipient: asAddress(event.params.to),
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      liquidity: event.params.liquidity,
      txHash: event.transaction.hash,
      blockNumber,
      blockTimestamp,
    };

    context.LiquidityEvent.set(liquidityEvent);
  },
);
