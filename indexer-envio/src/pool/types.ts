import type {
  EffectCaller,
  EvmOnEventContext,
  Pool,
  PoolSnapshot,
  PoolDailySnapshot,
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
