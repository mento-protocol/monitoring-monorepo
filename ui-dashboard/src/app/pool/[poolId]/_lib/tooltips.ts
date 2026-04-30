export const BOUNDARY_TOOLTIP =
  "Rebalance boundary in bps — the pool's allowed deviation from the oracle price. Effectiveness is measured against this boundary, not the oracle midpoint.";

export const EFFECTIVENESS_TOOLTIP =
  "100% = rebalance landed exactly on the boundary (ideal). >100% = overshoot past the boundary (e.g. all the way to the oracle — over-correction, wastes reserves). <100% = control loop under-correcting. Negative = rebalance made deviation worse.";

export const REWARD_TOOLTIP =
  "Caller incentive paid for triggering this rebalance, in USD. Computed indexer-side as: |notional swap volume on the USD-pegged side| × Pool.rebalanceReward bps / 10000. Shows '—' when the pool has no USD-pegged side or the pre-rebalance reserve RPC failed.";
