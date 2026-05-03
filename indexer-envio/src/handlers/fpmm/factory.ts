// ---------------------------------------------------------------------------
// FPMMFactory event handlers + FPMM.Transfer + applyLiquidityPositionDelta
// ---------------------------------------------------------------------------

import {
  FPMMFactory,
  FPMM,
  type FactoryDeployment,
  type LiquidityPosition,
} from "generated";
import {
  eventId,
  asAddress,
  asBigInt,
  makePoolId,
  extractAddressFromPoolId,
} from "../../helpers";
import { scalingFactorToDecimals } from "../../priceDifference";
import {
  fetchReferenceRateFeedID,
  fetchRebalanceThreshold,
  fetchTokenDecimalsScaling,
  fetchInvertRateFeed,
  fetchFees,
  fetchReportExpiry,
  fetchNumReporters,
} from "../../rpc";
import {
  DEFAULT_ORACLE_FIELDS,
  maybePreloadPool,
  upsertPool,
} from "../../pool";
import { isKnownFeeToken } from "../../feeToken";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function applyLiquidityPositionDelta({
  context,
  chainId,
  poolId,
  address,
  delta,
  blockNumber,
  blockTimestamp,
}: {
  context: {
    LiquidityPosition: {
      get: (id: string) => Promise<LiquidityPosition | undefined>;
      set: (entity: LiquidityPosition) => void;
    };
  };
  chainId: number;
  poolId: string;
  address: string;
  delta: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
}) {
  // Skip self-transfers where the pool contract receives its own LP tokens
  // (this happens during mint/burn ops — pool is neither an LP owner nor zero).
  const rawPoolAddress = extractAddressFromPoolId(poolId);
  if (address === ZERO_ADDRESS || address === rawPoolAddress || delta === 0n)
    return;

  const id = `${poolId}-${address}`;
  const existing = await context.LiquidityPosition.get(id);
  const prevBalance = existing?.netLiquidity ?? 0n;
  const nextBalance = prevBalance + delta;

  context.LiquidityPosition.set({
    id,
    chainId,
    poolId,
    address,
    netLiquidity: nextBalance > 0n ? nextBalance : 0n,
    lastUpdatedBlock: blockNumber,
    lastUpdatedTimestamp: blockTimestamp,
  });
}

// ---------------------------------------------------------------------------
// FPMMFactory
// ---------------------------------------------------------------------------

// Dynamically register the deployed pool + its fee tokens so Envio starts
// indexing all FPMM events (Swap, Mint, Burn, etc.) without needing a
// hardcoded address list in the config. Envio deduplicates addresses, so
// re-registering the same address on re-runs is harmless.
//
// SECURITY GATE: `addERC20FeeToken` is only called for tokens present in the
// canonical Mento registry (`@mento-protocol/contracts`). This prevents a
// compromised factory owner (or a misconfigured deployment) from registering
// an attacker-controlled ERC20 that spams Transfer events at the yield-split
// address — each of which would otherwise force the indexer to read pool
// state and burn RPC/DB quota. Pool creation itself is `onlyOwner` in the
// FPMMFactory, so this is defense in depth. New legitimate fee tokens ship
// via a `@mento-protocol/contracts` bump (plus a resync) — if a new token
// is observed here without a registry entry we log a warning so the gap is
// visible in operations. See: Codex finding
// https://chatgpt.com/codex/cloud/security/findings/bcfbd2e38c388191a52fb85205eb326d
//
// Note: contractRegister callbacks are a framework-level hook that Envio
// invokes before the handler. The Envio test harness (processEvent) only
// exercises the .handler() path, so this callback has no direct test
// coverage — this is a framework limitation, not an oversight. We mitigate
// by unit-testing `isKnownFeeToken` directly and asserting the callback is
// registered via the handler-registry introspection tests.
FPMMFactory.FPMMDeployed.contractRegister(({ event, context }) => {
  context.addFPMM(event.params.fpmmProxy);

  // Always log the pool address + tokens at registration so operators can
  // correlate a "token rejected" warning back to its source pool.
  const token0 = event.params.token0;
  const token1 = event.params.token1;

  if (isKnownFeeToken(event.chainId, token0)) {
    context.addERC20FeeToken(token0);
  } else {
    console.warn(
      `[FPMMFactory] Rejecting fee-token registration for unknown token0=${token0} ` +
        `on chain ${event.chainId} (pool=${event.params.fpmmProxy}). ` +
        `Bump @mento-protocol/contracts if this token is legitimate.`,
    );
  }

  if (isKnownFeeToken(event.chainId, token1)) {
    context.addERC20FeeToken(token1);
  } else {
    console.warn(
      `[FPMMFactory] Rejecting fee-token registration for unknown token1=${token1} ` +
        `on chain ${event.chainId} (pool=${event.params.fpmmProxy}). ` +
        `Bump @mento-protocol/contracts if this token is legitimate.`,
    );
  }
});

FPMMFactory.FPMMDeployed.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolAddr = asAddress(event.params.fpmmProxy); // raw address for RPC calls
  const poolId = makePoolId(event.chainId, poolAddr); // namespaced ID for DB entities
  // See UpdateReserves handler — heavy RPC fan-out (6+ Promise.all reads)
  // gets skipped during preload and runs only in processing.
  if (await maybePreloadPool(context, poolId)) return;
  const token0 = asAddress(event.params.token0);
  const token1 = asAddress(event.params.token1);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch oracle state from chain at pool creation
  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};

  const [
    rateFeedID,
    rebalanceThreshold,
    dec0Raw,
    dec1Raw,
    invertRateFeed,
    fees,
  ] = await Promise.all([
    fetchReferenceRateFeedID(event.chainId, poolAddr),
    // Use standalone getters — they work even when the oracle is stale,
    // unlike getRebalancingState() which reverts on stale/expired oracle data.
    fetchRebalanceThreshold(event.chainId, poolAddr),
    // Fetch token decimals scaling factors (e.g. 1e18 for 18-decimal tokens)
    fetchTokenDecimalsScaling(event.chainId, poolAddr, "decimals0", token0),
    fetchTokenDecimalsScaling(event.chainId, poolAddr, "decimals1", token1),
    fetchInvertRateFeed(event.chainId, poolAddr),
    fetchFees(event.chainId, poolAddr),
  ]);
  // Convert scaling factor (1e18, 1e6, etc.) to decimals count (18, 6, etc.)
  const token0Decimals = dec0Raw
    ? (scalingFactorToDecimals(dec0Raw) ?? 18)
    : 18;
  const token1Decimals = dec1Raw
    ? (scalingFactorToDecimals(dec1Raw) ?? 18)
    : 18;

  if (rateFeedID) {
    oracleDelta.referenceRateFeedID = rateFeedID;
    // Seed oracleExpiry and oracleNumReporters at pool creation so oracle
    // handlers can read them from the DB without per-event RPC calls.
    const [oracleExpiry, numReporters] = await Promise.all([
      fetchReportExpiry(event.chainId, rateFeedID, blockNumber),
      fetchNumReporters(event.chainId, rateFeedID, blockNumber),
    ]);
    if (oracleExpiry !== null) {
      oracleDelta.oracleExpiry = oracleExpiry;
    }
    if (numReporters !== null) {
      oracleDelta.oracleNumReporters = numReporters;
    }
  }

  oracleDelta.invertRateFeed = invertRateFeed;

  if (rebalanceThreshold > 0) {
    oracleDelta.rebalanceThreshold = rebalanceThreshold;
  }

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    token0,
    token1,
    source: "fpmm_factory",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    oracleDelta,
    tokenDecimals: { token0Decimals, token1Decimals },
  });

  // Persist fee config read at pool creation. `fees` is Partial — only
  // fields whose RPC call succeeded are present, so a partial failure
  // leaves the others at the -1 sentinel for self-heal to retry.
  if (fees) {
    context.Pool.set({ ...pool, ...fees });
  }

  const deployment: FactoryDeployment = {
    id,
    chainId: event.chainId,
    poolId,
    token0,
    token1,
    implementation: asAddress(event.params.fpmmImplementation),
    factoryAddress: asAddress(event.srcAddress),
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.FactoryDeployment.set(deployment);
});

// ---------------------------------------------------------------------------
// FPMM.Transfer (LP token ownership)
// ---------------------------------------------------------------------------

FPMM.Transfer.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const from = asAddress(event.params.from);
  const to = asAddress(event.params.to);
  const value = event.params.value;

  // LiquidityPosition tracks actual LP token ownership. For burns, the owner is
  // only observable via LP token Transfer events (owner -> pool, then pool -> 0x0),
  // not the Burn event's `to` beneficiary.
  await applyLiquidityPositionDelta({
    context,
    chainId: event.chainId,
    poolId,
    address: from,
    delta: -value,
    blockNumber,
    blockTimestamp,
  });
  await applyLiquidityPositionDelta({
    context,
    chainId: event.chainId,
    poolId,
    address: to,
    delta: value,
    blockNumber,
    blockTimestamp,
  });
});
