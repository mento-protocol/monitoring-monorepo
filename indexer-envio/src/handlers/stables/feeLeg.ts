// ---------------------------------------------------------------------------
// Yield-split inflow routing for StableToken Transfer events.
//
// The Mento stables (cUSD-USDm, EURm, GBPm, JPYm, CHFm, …) are statically
// bound to the `StableToken` contract type in config.multichain.*.yaml, and
// Envio binds each address to exactly one contract type — so the dynamic
// `ERC20FeeToken` registration in handlers/fpmm/factory.ts can never claim
// them. Protocol-fee transfers paid in these tokens therefore arrive on the
// StableToken subscription (via the `{to: YIELD_SPLIT_ADDRESS}` where param
// added in transfer.ts) and are routed here. Two flows:
//
//   1. Pool → Safe (swap-fee leg): same contract as handlers/feeToken.ts —
//      sender must be an indexed FPMM/VirtualPool row, then write a
//      ProtocolFeeTransfer + roll it into PoolDailyFeeSnapshot. Token
//      metadata comes from the stables registry (no RPC, never UNKNOWN).
//   2. 0x0 → Safe in a CDP debt token (collected borrowing revenue):
//      ActivePool._mintAggInterest mints the treasury share
//      ((1 − SP_YIELD_SPLIT) × (interest + upfront fee)) straight to the
//      interestRouter, which is the Safe. Rolled into the LiquityInstance
//      cum + LiquityBorrowingRevenueDailySnapshot.collected (cash basis).
//
// Non-pool, non-mint senders are skipped — same anti-spam invariant as
// feeToken.ts: arbitrary third-party transfers to the Safe must not inflate
// the protocol fee KPIs.
// ---------------------------------------------------------------------------

import type { Pool, ProtocolFeeTransfer } from "envio";
import { ZERO_ADDRESS } from "../../constants.js";
import { YIELD_SPLIT_ADDRESS } from "../../feeToken.js";
import {
  asAddress,
  eventId,
  isVirtualPool,
  makePoolId,
} from "../../helpers.js";
import {
  preloadPoolDailyFeeSnapshot,
  upsertPoolDailyFeeSnapshot,
} from "../../protocolFeeSnapshot.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "../liquity/bootstrap.js";
import {
  preloadBorrowingCollectedBucket,
  recordBorrowingCollected,
} from "../liquity/borrowingRevenue.js";
import {
  findLiquityMarketByDebtToken,
  makeCollateralId,
} from "../liquity/config.js";
import { touchLiquityInstance } from "../liquity/instance.js";
import {
  findLockAndMintNttStableByAddress,
  findStableByAddress,
} from "./config.js";

type YieldSplitInflowEvent = {
  chainId: number;
  srcAddress: string;
  logIndex: number;
  params: { from: string; to: string; value: bigint };
  block: { number: number; timestamp: number };
  transaction: { hash: string };
};

// Structural subset of the generated handler context — keeps this module
// unit-testable against a mock without importing the full Envio context type.
type YieldSplitInflowContext = {
  isPreload: boolean;
  Pool: {
    get: (id: string) => Promise<Pool | undefined>;
  };
  ProtocolFeeTransfer: {
    get: (id: string) => Promise<ProtocolFeeTransfer | undefined>;
    set: (entity: ProtocolFeeTransfer) => void;
  };
  PoolDailyFeeSnapshot: Parameters<
    typeof upsertPoolDailyFeeSnapshot
  >[0]["context"]["PoolDailyFeeSnapshot"];
} & Parameters<typeof getOrCreateLiquityInstance>[0] &
  Parameters<typeof recordBorrowingCollected>[0];

/** Token metadata for a YAML-listed stable: registry first (Celo reserve
 *  stables + Monad NTT stables), then the lock/mint NTT custody set (Celo
 *  GBPm/CHFm/JPYm, which are excluded from STABLES). */
const stableFeeTokenMeta = (
  chainId: number,
  tokenAddress: string,
): { symbol: string; decimals: number } | undefined =>
  findStableByAddress(chainId, tokenAddress) ??
  findLockAndMintNttStableByAddress(chainId, tokenAddress);

export async function handleYieldSplitInflow({
  event,
  context,
}: {
  event: YieldSplitInflowEvent;
  context: YieldSplitInflowContext;
}): Promise<void> {
  if (asAddress(event.params.to) !== YIELD_SPLIT_ADDRESS) return;

  const from = asAddress(event.params.from);
  if (from === ZERO_ADDRESS) {
    await handleCollectedBorrowingRevenue({ event, context });
    return;
  }
  await handleStableSwapFeeLeg({ event, context, sender: from });
}

async function handleCollectedBorrowingRevenue({
  event,
  context,
}: {
  event: YieldSplitInflowEvent;
  context: YieldSplitInflowContext;
}): Promise<void> {
  const market = findLiquityMarketByDebtToken(event.chainId, event.srcAddress);
  // Mints to the Safe in non-CDP tokens are not borrowing revenue; the
  // supply path in transfer.ts still accounts for them as ordinary mints.
  if (market === undefined) return;

  const blockTimestamp = BigInt(event.block.timestamp);
  if (context.isPreload) {
    await preloadLiquityMarket(context, market);
    await preloadBorrowingCollectedBucket(
      context,
      makeCollateralId(market),
      event.params.value,
      blockTimestamp,
    );
    return;
  }

  const blockNumber = BigInt(event.block.number);
  let instance = await getOrCreateLiquityInstance(
    context,
    market,
    blockNumber,
    blockTimestamp,
  );
  instance = await recordBorrowingCollected(
    context,
    instance,
    event.params.value,
    blockTimestamp,
    blockNumber,
  );
  context.LiquityInstance.set(
    touchLiquityInstance(instance, blockNumber, blockTimestamp),
  );
}

async function handleStableSwapFeeLeg({
  event,
  context,
  sender,
}: {
  event: YieldSplitInflowEvent;
  context: YieldSplitInflowContext;
  sender: string;
}): Promise<void> {
  // Sender provenance check — mirrors handlers/feeToken.ts: only transfers
  // originating from indexed FPMM/VirtualPool rows count as protocol fees.
  const pool = await context.Pool.get(makePoolId(event.chainId, sender));
  if (!pool || (!pool.source.includes("fpmm") && !isVirtualPool(pool))) {
    return;
  }

  const meta = stableFeeTokenMeta(event.chainId, event.srcAddress);
  // Every delivered event's srcAddress is YAML-listed, so the registry
  // lookup cannot miss in practice; bail rather than write an UNKNOWN row.
  if (meta === undefined) return;

  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const blockTimestamp = BigInt(event.block.timestamp);
  if (context.isPreload) {
    await Promise.all([
      context.ProtocolFeeTransfer.get(id),
      preloadPoolDailyFeeSnapshot({ context, pool, blockTimestamp }),
    ]);
    return;
  }

  const normalizedToken = asAddress(event.srcAddress);
  // Replay dedup: the transfer row is id-keyed (idempotent overwrite), but
  // the snapshot rollup is additive — only roll it in on first indexing.
  // No UNKNOWN-heal branch here: registry metadata is static and complete.
  const existingTransfer = await context.ProtocolFeeTransfer.get(id);

  context.ProtocolFeeTransfer.set({
    id,
    chainId: event.chainId,
    token: normalizedToken,
    tokenSymbol: meta.symbol,
    tokenDecimals: meta.decimals,
    amount: event.params.value,
    from: sender,
    txHash: event.transaction.hash,
    blockNumber: BigInt(event.block.number),
    blockTimestamp,
  });

  if (!existingTransfer) {
    await upsertPoolDailyFeeSnapshot({
      context,
      chainId: event.chainId,
      pool,
      blockTimestamp,
      blockNumber: BigInt(event.block.number),
      token: normalizedToken,
      tokenSymbol: meta.symbol,
      tokenDecimals: meta.decimals,
      amount: event.params.value,
      mode: "add",
    });
  }
}
