import type {
  EffectCaller,
  EvmOnEventContext,
  Pool,
  PoolSnapshot,
  PoolDailySnapshot,
  OraclePriceDailySnapshot,
  DeviationThresholdBreach,
} from "envio";

export type PoolContext = {
  effect: EffectCaller;
  Pool: {
    get: (id: string) => Promise<Pool | undefined>;
    set: (entity: Pool) => void;
  };
  DeviationThresholdBreach: {
    get: (id: string) => Promise<DeviationThresholdBreach | undefined>;
    set: (entity: DeviationThresholdBreach) => void;
  };
  // Used by `selfHealWrappedExchangeId` to patch the back-reference on the
  // matching exchange row when a VP heals its `wrappedExchangeId`.
  BiPoolExchange: EvmOnEventContext["BiPoolExchange"];
  // Used by `computeFeedHalted` to recompute `breakerTripped` when a pool's
  // rate feed is first assigned (so a pool appearing mid-halt isn't stuck false).
  BreakerConfig: EvmOnEventContext["BreakerConfig"];
  Breaker: EvmOnEventContext["Breaker"];
  // `computeFeedHalted` also ORs in each dependency feed's halt (one level).
  RateFeedDependency: EvmOnEventContext["RateFeedDependency"];
};

export type SnapshotContext = {
  PoolSnapshot: {
    get: (id: string) => Promise<PoolSnapshot | undefined>;
    set: (entity: PoolSnapshot) => void;
  };
  PoolDailySnapshot: {
    get: (id: string) => Promise<PoolDailySnapshot | undefined>;
    set: (entity: PoolDailySnapshot) => void;
  };
};

export type OracleRollupContext = {
  OraclePriceDailySnapshot: {
    get: (id: string) => Promise<OraclePriceDailySnapshot | undefined>;
    set: (entity: OraclePriceDailySnapshot) => void;
  };
};
