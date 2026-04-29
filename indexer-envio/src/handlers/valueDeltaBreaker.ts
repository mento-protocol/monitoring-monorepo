// ---------------------------------------------------------------------------
// ValueDeltaBreaker event handlers
//
// Per-feed config + reference value for stablecoin Value Delta breakers.
// Trip / reset transitions are handled by the BreakerBox handler.
// ---------------------------------------------------------------------------

import { ValueDeltaBreaker } from "generated";
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

// Cooldown + threshold config events are shared with MedianDeltaBreaker.
ValueDeltaBreaker.DefaultCooldownTimeUpdated.handler(
  handleDefaultCooldownTimeUpdated,
);
ValueDeltaBreaker.DefaultRateChangeThresholdUpdated.handler(
  handleDefaultRateChangeThresholdUpdated,
);
ValueDeltaBreaker.RateFeedCooldownTimeUpdated.handler(
  handleRateFeedCooldownTimeUpdated,
);
ValueDeltaBreaker.RateChangeThresholdUpdated.handler(
  handleRateChangeThresholdUpdated,
);

// ---------------------------------------------------------------------------
// ValueDelta-only: reference value (the fixed peg, e.g. 1.0)
// ---------------------------------------------------------------------------

ValueDeltaBreaker.ReferenceValueUpdated.handler(async ({ event, context }) => {
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

  const ref = event.params.referenceValue;
  if (cfg.referenceValue === ref) return;
  context.BreakerConfig.set({ ...cfg, referenceValue: ref });
});
