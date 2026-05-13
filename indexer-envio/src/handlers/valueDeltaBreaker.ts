// ---------------------------------------------------------------------------
// ValueDeltaBreaker event handlers
//
// Per-feed config + reference value for stablecoin Value Delta breakers.
// Trip / reset transitions are handled by the BreakerBox handler.
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

// Cooldown + threshold config events are shared with MedianDeltaBreaker.
indexer.onEvent(
  { contract: "ValueDeltaBreaker", event: "DefaultCooldownTimeUpdated" },
  handleDefaultCooldownTimeUpdated,
);
indexer.onEvent(
  { contract: "ValueDeltaBreaker", event: "DefaultRateChangeThresholdUpdated" },
  handleDefaultRateChangeThresholdUpdated,
);
indexer.onEvent(
  { contract: "ValueDeltaBreaker", event: "RateFeedCooldownTimeUpdated" },
  handleRateFeedCooldownTimeUpdated,
);
indexer.onEvent(
  { contract: "ValueDeltaBreaker", event: "RateChangeThresholdUpdated" },
  handleRateChangeThresholdUpdated,
);

// ---------------------------------------------------------------------------
// ValueDelta-only: reference value (the fixed peg, e.g. 1.0)
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "ValueDeltaBreaker", event: "ReferenceValueUpdated" },
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

    const ref = event.params.referenceValue;
    if (cfg.referenceValue === ref) return;
    context.BreakerConfig.set({ ...cfg, referenceValue: ref });
  },
);
