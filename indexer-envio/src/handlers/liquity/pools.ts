import { indexer } from "../../indexer.js";
import { asBigInt } from "../../helpers.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "./bootstrap.js";
import type { LiquityBootstrapContext } from "./bootstrap.js";
import { findLiquityMarketByEventSource } from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import type {
  LiquityInstanceDailySnapshot,
  LiquityInstanceSnapshot,
  StableSupplyDailySnapshot,
} from "envio";

type PoolGaugeContext = LiquityBootstrapContext & {
  isPreload: boolean;
  LiquityInstanceSnapshot: { set: (entity: LiquityInstanceSnapshot) => void };
  LiquityInstanceDailySnapshot: {
    set: (entity: LiquityInstanceDailySnapshot) => void;
  };
  StableSupplyDailySnapshot: {
    set: (entity: StableSupplyDailySnapshot) => void;
  };
};

async function updatePoolGauge({
  event,
  context,
  delta,
}: {
  event: {
    chainId: number;
    srcAddress: string;
    block: { number: number; timestamp: number };
  };
  context: PoolGaugeContext;
  delta: {
    activePoolDebt?: bigint;
    activePoolColl?: bigint;
    defaultPoolDebt?: bigint;
    defaultPoolColl?: bigint;
  };
}) {
  const market = findLiquityMarketByEventSource(
    event.chainId,
    event.srcAddress,
  );
  if (market === undefined) return;
  if (context.isPreload) {
    await preloadLiquityMarket(context, market);
    return;
  }
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const instance = await getOrCreateLiquityInstance(
    context,
    market,
    blockNumber,
    blockTimestamp,
  );
  const next = touchLiquityInstance(
    flushLiquitySnapshots(context, instance, blockTimestamp, blockNumber),
    blockNumber,
    blockTimestamp,
  );
  const activePoolDebt = delta.activePoolDebt ?? next.activePoolDebt;
  const activePoolColl = delta.activePoolColl ?? next.activePoolColl;
  const defaultPoolDebt = delta.defaultPoolDebt ?? next.defaultPoolDebt;
  const defaultPoolColl = delta.defaultPoolColl ?? next.defaultPoolColl;
  // Mento's deployed fork never emits `ActivePoolBoldDebtUpdated`, so the
  // active-pool side of systemDebt is owned by the trove handlers (via
  // `applySystemDebtDelta`). The DefaultPool side is different: when a
  // liquidation redistributes debt, the closed trove's full debt is
  // subtracted by `applySystemDebtDelta`, but the redistributed portion is
  // still outstanding in the DefaultPool until other troves apply pending
  // rewards. `DefaultPoolBoldDebtUpdated` does fire on the fork, so apply
  // its delta back into systemDebt to keep the accounting whole:
  //   systemDebt = Σ open-trove recorded debts (delta-tracked) + defaultPoolDebt
  const defaultPoolDebtDelta = defaultPoolDebt - next.defaultPoolDebt;
  context.LiquityInstance.set({
    ...next,
    activePoolDebt,
    activePoolColl,
    defaultPoolDebt,
    defaultPoolColl,
    systemColl: activePoolColl + defaultPoolColl,
    systemDebt: next.systemDebt + defaultPoolDebtDelta,
    tcrBps: -1,
  });
}

indexer.onEvent(
  { contract: "LiquityActivePool", event: "ActivePoolBoldDebtUpdated" },
  async ({ event, context }) => {
    await updatePoolGauge({
      event,
      context,
      delta: { activePoolDebt: event.params._recordedDebtSum },
    });
  },
);

indexer.onEvent(
  { contract: "LiquityActivePool", event: "ActivePoolCollBalanceUpdated" },
  async ({ event, context }) => {
    await updatePoolGauge({
      event,
      context,
      delta: { activePoolColl: event.params._collBalance },
    });
  },
);

indexer.onEvent(
  { contract: "LiquityDefaultPool", event: "DefaultPoolBoldDebtUpdated" },
  async ({ event, context }) => {
    await updatePoolGauge({
      event,
      context,
      delta: { defaultPoolDebt: event.params._boldDebt },
    });
  },
);

indexer.onEvent(
  { contract: "LiquityDefaultPool", event: "DefaultPoolCollBalanceUpdated" },
  async ({ event, context }) => {
    await updatePoolGauge({
      event,
      context,
      delta: { defaultPoolColl: event.params._collBalance },
    });
  },
);
