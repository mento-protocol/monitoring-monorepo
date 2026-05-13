// ---------------------------------------------------------------------------
// MedianDeltaBreaker event handlers
//
// Per-feed config + EMA state for the FX-pool Median Delta breakers. Trip /
// reset transitions are handled by the BreakerBox handler (it's the only
// contract that emits trip/reset events).
//
// EMA mirroring on each `MedianUpdated` lives in sortedOracles.ts —
// not here, because the contract recomputes EMA only when SortedOracles
// invokes `_checkAndSetBreakers`, and we know the inputs from that event.
// ---------------------------------------------------------------------------

import { indexer } from "../indexer.js";
import { asAddress, asBigInt } from "../helpers.js";
import {
  ensureBreaker,
  ensureBreakerConfig,
  handleDefaultCooldownTimeUpdated,
  handleDefaultRateChangeThresholdUpdated,
  handleRateChangeThresholdUpdated,
  handleRateFeedCooldownTimeUpdated,
  makeBreakerId,
  maybePreloadBreaker,
} from "../breakers.js";

// Cooldown + threshold config events are shared with ValueDeltaBreaker —
// both contracts inherit WithCooldown + WithThreshold in mento-core.
indexer.onEvent(
  { contract: "MedianDeltaBreaker", event: "DefaultCooldownTimeUpdated" },
  handleDefaultCooldownTimeUpdated,
);
indexer.onEvent(
  {
    contract: "MedianDeltaBreaker",
    event: "DefaultRateChangeThresholdUpdated",
  },
  handleDefaultRateChangeThresholdUpdated,
);
indexer.onEvent(
  { contract: "MedianDeltaBreaker", event: "RateFeedCooldownTimeUpdated" },
  handleRateFeedCooldownTimeUpdated,
);
indexer.onEvent(
  { contract: "MedianDeltaBreaker", event: "RateChangeThresholdUpdated" },
  handleRateChangeThresholdUpdated,
);

// ---------------------------------------------------------------------------
// MedianDelta-only: smoothing factor + EMA reset
// ---------------------------------------------------------------------------

// NOTE: the contract emits `rateFeedId` (lowercase i) on this event —
// distinct from the `rateFeedID` casing used everywhere else.
indexer.onEvent(
  { contract: "MedianDeltaBreaker", event: "SmoothingFactorSet" },
  async ({ event, context }) => {
    const breakerAddress = asAddress(event.srcAddress);
    const rateFeedID = asAddress(event.params.rateFeedId);
    const breakerId = makeBreakerId(event.chainId, breakerAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    if (await maybePreloadBreaker(context, breakerId)) return;

    const breaker = await ensureBreaker(
      context,
      event.chainId,
      breakerAddress,
      blockNumber,
      blockTimestamp,
    );
    if (!breaker) return;
    const cfg = await ensureBreakerConfig(
      context,
      event.chainId,
      breaker,
      rateFeedID,
      blockNumber,
    );
    if (!cfg) return;

    const sf = event.params.smoothingFactor;
    if (cfg.smoothingFactor === sf) return;
    context.BreakerConfig.set({ ...cfg, smoothingFactor: sf });
  },
);

indexer.onEvent(
  { contract: "MedianDeltaBreaker", event: "MedianRateEMAReset" },
  async ({ event, context }) => {
    const breakerAddress = asAddress(event.srcAddress);
    const rateFeedID = asAddress(event.params.rateFeedID);
    const breakerId = makeBreakerId(event.chainId, breakerAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    if (await maybePreloadBreaker(context, breakerId)) return;

    const breaker = await ensureBreaker(
      context,
      event.chainId,
      breakerAddress,
      blockNumber,
      blockTimestamp,
    );
    if (!breaker) return;
    const cfg = await ensureBreakerConfig(
      context,
      event.chainId,
      breaker,
      rateFeedID,
      blockNumber,
    );
    if (!cfg) return;

    // Mirror contract: medianRatesEMA[feed] = 0. Next MedianUpdated will see
    // EMA == 0 and re-seed it from the new median (sortedOracles handler).
    if (cfg.medianRatesEMA === 0n) return;
    context.BreakerConfig.set({ ...cfg, medianRatesEMA: 0n });
  },
);
