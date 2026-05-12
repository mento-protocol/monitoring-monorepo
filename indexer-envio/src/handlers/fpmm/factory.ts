// ---------------------------------------------------------------------------
// FPMMFactory event handlers + FPMM.Transfer + applyLiquidityPositionDelta
// ---------------------------------------------------------------------------

import { indexer, type FactoryDeployment, type LiquidityPosition } from "envio";
import {
  eventId,
  asAddress,
  asBigInt,
  makePoolId,
  extractAddressFromPoolId,
} from "../../helpers.js";
import { parseDecimalsPair } from "../../priceDifference.js";
import {
  compactFees,
  feesEffect,
  invertRateFeedEffect,
  numReportersEffect,
  rebalanceThresholdsEffect,
  referenceRateFeedIDEffect,
  reportExpiryEffect,
  tokenDecimalsScalingEffect,
} from "../../rpc/effects.js";
import {
  DEFAULT_ORACLE_FIELDS,
  maybePreloadPool,
  upsertPool,
} from "../../pool.js";
import { isKnownFeeToken } from "../../feeToken.js";
import { ZERO_ADDRESS } from "../../constants.js";

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
indexer.contractRegister(
  { contract: "FPMMFactory", event: "FPMMDeployed" },
  async ({ event, context }) => {
    context.chain.FPMM.add(event.params.fpmmProxy);

    // Always log the pool address + tokens at registration so operators can
    // correlate a "token rejected" warning back to its source pool.
    const token0 = event.params.token0;
    const token1 = event.params.token1;

    if (isKnownFeeToken(event.chainId, token0)) {
      context.chain.ERC20FeeToken.add(token0);
    } else {
      context.log.warn(
        `[FPMMFactory] Rejecting fee-token registration for unknown token0=${token0} ` +
          `on chain ${event.chainId} (pool=${event.params.fpmmProxy}). ` +
          `Bump @mento-protocol/contracts if this token is legitimate.`,
      );
    }

    if (isKnownFeeToken(event.chainId, token1)) {
      context.chain.ERC20FeeToken.add(token1);
    } else {
      context.log.warn(
        `[FPMMFactory] Rejecting fee-token registration for unknown token1=${token1} ` +
          `on chain ${event.chainId} (pool=${event.params.fpmmProxy}). ` +
          `Bump @mento-protocol/contracts if this token is legitimate.`,
      );
    }
  },
);

indexer.onEvent(
  { contract: "FPMMFactory", event: "FPMMDeployed" },
  async ({ event, context }) => {
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
      rebalanceThresholds,
      dec0Raw,
      dec1Raw,
      invertRateFeed,
      fees,
    ] = await Promise.all([
      context.effect(referenceRateFeedIDEffect, {
        chainId: event.chainId,
        poolAddress: poolAddr,
      }),
      // Use standalone getters — they work even when the oracle is stale,
      // unlike getRebalancingState() which reverts on stale/expired oracle data.
      // Read at the deploy block so historical replay sees the deploy-time
      // configuration, not whatever governance has changed it to since.
      context.effect(rebalanceThresholdsEffect, {
        chainId: event.chainId,
        poolAddress: poolAddr,
        blockNumber,
      }),
      // Fetch token decimals scaling factors (e.g. 1e18 for 18-decimal tokens)
      context.effect(tokenDecimalsScalingEffect, {
        chainId: event.chainId,
        poolAddress: poolAddr,
        fn: "decimals0",
        fallbackTokenAddress: token0,
      }),
      context.effect(tokenDecimalsScalingEffect, {
        chainId: event.chainId,
        poolAddress: poolAddr,
        fn: "decimals1",
        fallbackTokenAddress: token1,
      }),
      context.effect(invertRateFeedEffect, {
        chainId: event.chainId,
        poolAddress: poolAddr,
      }),
      context.effect(feesEffect, {
        chainId: event.chainId,
        poolAddress: poolAddr,
      }),
    ]);
    const tokenDecimals = parseDecimalsPair(dec0Raw, dec1Raw);

    if (rateFeedID) {
      // Seed oracleExpiry and oracleNumReporters at pool creation so oracle
      // handlers can read them from the DB without per-event RPC calls.
      const [oracleExpiry, numReporters] = await Promise.all([
        context.effect(reportExpiryEffect, {
          chainId: event.chainId,
          rateFeedID,
          blockNumber,
        }),
        context.effect(numReportersEffect, {
          chainId: event.chainId,
          rateFeedID,
          blockNumber,
        }),
      ]);
      if (oracleExpiry !== null) {
        oracleDelta.oracleExpiry = oracleExpiry;
      }
      if (numReporters !== null) {
        oracleDelta.oracleNumReporters = numReporters;
      }
    }
    // `referenceRateFeedID` flows through the dedicated upsertPool param
    // (not through oracleDelta) so it isn't clobbered by the spread chain
    // — see DEFAULT_ORACLE_FIELDS doc.

    // Only persist invertRateFeed when the RPC actually succeeded, and stamp
    // `invertRateFeedKnown` so upsertPool's self-heal stops retrying. When the
    // read failed, both fields stay at the schema defaults and the self-heal
    // path picks up the correction on the next event for this pool.
    if (invertRateFeed !== null) {
      oracleDelta.invertRateFeed = invertRateFeed;
      oracleDelta.invertRateFeedKnown = true;
    }

    if (rebalanceThresholds !== null) {
      const { above, below } = rebalanceThresholds;
      oracleDelta.rebalanceThresholdAbove = above;
      oracleDelta.rebalanceThresholdBelow = below;
      oracleDelta.rebalanceThresholdsKnown = true;
      // Active threshold seed: the contract picks above OR below at evaluation
      // time based on reservePriceAboveOraclePrice. Pre-first-event we don't
      // know the direction, so seed with `max(above, below)` (the broadest
      // band) — the next UpdateReserves/Rebalanced will refresh with the
      // direction-correct value via `tryDeriveRebalanceState`. Skip when both
      // are 0 (configured to never rebalance) so the legacy field stays at
      // its 0 default; the `rebalanceThresholdsKnown: true` flag distinguishes
      // this legitimate state from "RPC failed".
      const broadest = Math.max(above, below);
      if (broadest > 0) {
        oracleDelta.rebalanceThreshold = broadest;
      }
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
      tokenDecimals,
      referenceRateFeedID: rateFeedID ?? undefined,
    });

    // Persist fee config read at pool creation. `compactFees` strips
    // undefined keys (effect schema outputs explicit undefined for missing
    // getters) so a partial failure leaves the others at the -1 sentinel
    // for self-heal to retry.
    if (fees) {
      context.Pool.set({ ...pool, ...compactFees(fees) });
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
  },
);

// ---------------------------------------------------------------------------
// FPMM.Transfer (LP token ownership)
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "Transfer" },
  async ({ event, context }) => {
    const poolId = makePoolId(event.chainId, event.srcAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const from = asAddress(event.params.from);
    const to = asAddress(event.params.to);
    const value = event.params.value;

    // Self-transfers are no-ops for LP accounting: net liquidity is unchanged.
    // Also guards the Promise.all below: ensures the two writes always target
    // distinct LiquidityPosition records, preventing a concurrent get/set race.
    if (from === to) return;

    // LiquidityPosition tracks actual LP token ownership. For burns, the owner is
    // only observable via LP token Transfer events (owner -> pool, then pool -> 0x0),
    // not the Burn event's `to` beneficiary. The two delta writes target distinct
    // LiquidityPosition records (`${poolId}-${from}` vs `${poolId}-${to}`), so they
    // are independent and can run concurrently.
    await Promise.all([
      applyLiquidityPositionDelta({
        context,
        chainId: event.chainId,
        poolId,
        address: from,
        delta: -value,
        blockNumber,
        blockTimestamp,
      }),
      applyLiquidityPositionDelta({
        context,
        chainId: event.chainId,
        poolId,
        address: to,
        delta: value,
        blockNumber,
        blockTimestamp,
      }),
    ]);
  },
);
