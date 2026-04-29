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

import { MedianDeltaBreaker } from "generated";
import { asAddress, asBigInt } from "../helpers";
import {
  ensureBreaker,
  ensureBreakerConfig,
  handleDefaultCooldownTimeUpdated,
  handleDefaultRateChangeThresholdUpdated,
  handleRateChangeThresholdUpdated,
  handleRateFeedCooldownTimeUpdated,
  makeBreakerId,
  maybePreloadBreaker,
} from "../breakers";

// Cooldown + threshold config events are shared with ValueDeltaBreaker —
// both contracts inherit WithCooldown + WithThreshold in mento-core.
MedianDeltaBreaker.DefaultCooldownTimeUpdated.handler(
  handleDefaultCooldownTimeUpdated,
);
MedianDeltaBreaker.DefaultRateChangeThresholdUpdated.handler(
  handleDefaultRateChangeThresholdUpdated,
);
MedianDeltaBreaker.RateFeedCooldownTimeUpdated.handler(
  handleRateFeedCooldownTimeUpdated,
);
MedianDeltaBreaker.RateChangeThresholdUpdated.handler(
  handleRateChangeThresholdUpdated,
);

// ---------------------------------------------------------------------------
// MedianDelta-only: smoothing factor + EMA reset
// ---------------------------------------------------------------------------

// NOTE: the contract emits `rateFeedId` (lowercase i) on this event —
// distinct from the `rateFeedID` casing used everywhere else.
MedianDeltaBreaker.SmoothingFactorSet.handler(async ({ event, context }) => {
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
});

MedianDeltaBreaker.MedianRateEMAReset.handler(async ({ event, context }) => {
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
});
