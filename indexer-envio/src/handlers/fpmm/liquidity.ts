// ---------------------------------------------------------------------------
// FPMM.Mint and FPMM.Burn handlers
// ---------------------------------------------------------------------------

import { FPMM, type LiquidityEvent } from "generated";
import { eventId, asAddress, asBigInt, makePoolId } from "../../helpers";
import { maybePreloadPool, upsertPool, upsertSnapshot } from "../../pool";

// ---------------------------------------------------------------------------
// FPMM.Mint
// ---------------------------------------------------------------------------

FPMM.Mint.handler(async ({ event, context }) => {
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
});

// ---------------------------------------------------------------------------
// FPMM.Burn
// ---------------------------------------------------------------------------

FPMM.Burn.handler(async ({ event, context }) => {
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
});
