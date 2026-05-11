import type { EffectCaller } from "envio";
import type {
  Pool,
  PoolSnapshot,
  PoolDailySnapshot,
  DeviationThresholdBreach,
} from "generated";
import type { HandlerContext } from "generated/src/Types";

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
  BiPoolExchange: HandlerContext["BiPoolExchange"];
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
