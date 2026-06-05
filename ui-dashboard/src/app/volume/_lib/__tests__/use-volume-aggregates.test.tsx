/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerTraderDailyRow, TraderDailyRow } from "@/lib/volume";
import { useVolumeAggregates } from "../use-volume-aggregates";

type ViewModel = ReturnType<typeof useVolumeAggregates>;
type ResultRef = { current: ViewModel | null };

const USD_WEI = BigInt(10) ** BigInt(18);
const DAY = "1767225600";
const USER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXCLUDED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function usdWei(amount: number): string {
  return (BigInt(amount) * USD_WEI).toString();
}

function trader(
  overrides: Partial<TraderDailyRow> & Pick<TraderDailyRow, "trader">,
): TraderDailyRow {
  return {
    id: `${overrides.trader}-${overrides.timestamp ?? DAY}`,
    chainId: 42220,
    timestamp: DAY,
    swapCount: 1,
    uniquePools: 1,
    volumeUsdWei: usdWei(0),
    feesPaidUsdWei: "0",
    isProtocolActor: false,
    aggregatorKeys: [],
    lastSeenTimestamp: DAY,
    ...overrides,
    trader: overrides.trader,
  };
}

function brokerTrader(
  overrides: Partial<BrokerTraderDailyRow> &
    Pick<BrokerTraderDailyRow, "trader">,
): BrokerTraderDailyRow {
  return {
    id: `${overrides.trader}-${overrides.timestamp ?? DAY}`,
    chainId: 42220,
    timestamp: DAY,
    swapCount: 1,
    volumeUsdWei: usdWei(0),
    isProtocolActor: false,
    lastSeenTimestamp: DAY,
    ...overrides,
    trader: overrides.trader,
  };
}

function HookWrapper({
  resultRef,
  traderRows,
  v2TraderRows,
}: {
  resultRef: ResultRef;
  traderRows: readonly TraderDailyRow[];
  v2TraderRows: readonly BrokerTraderDailyRow[];
}) {
  resultRef.current = useVolumeAggregates({
    exclusions: { addresses: [EXCLUDED], sources: [] },
    venue: "v3",
    includeProtocolActors: false,
    traderRows,
    v2TraderRows,
    v3AggregatorRows: [],
    v2AggregatorRows: [],
  });
  return null;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function renderVm({
  traderRows,
  v2TraderRows,
}: {
  traderRows: readonly TraderDailyRow[];
  v2TraderRows: readonly BrokerTraderDailyRow[];
}): ViewModel {
  const ref: ResultRef = { current: null };
  act(() => {
    root.render(
      <HookWrapper
        resultRef={ref}
        traderRows={traderRows}
        v2TraderRows={v2TraderRows}
      />,
    );
  });
  if (!ref.current) throw new Error("missing volume aggregate model");
  return ref.current;
}

describe("useVolumeAggregates", () => {
  it("keeps headline daily volume unfiltered while analysis rows honor exclusions", () => {
    const model = renderVm({
      traderRows: [
        trader({ trader: USER, volumeUsdWei: usdWei(100) }),
        trader({ trader: EXCLUDED, volumeUsdWei: usdWei(50) }),
      ],
      v2TraderRows: [
        brokerTrader({ trader: USER, volumeUsdWei: usdWei(70) }),
        brokerTrader({ trader: EXCLUDED, volumeUsdWei: usdWei(30) }),
      ],
    });

    expect(model.aggregated).toHaveLength(1);
    expect(model.aggregated[0]?.trader).toBe(USER);
    expect(model.aggregated[0]?.volumeUsdWei).toBe(BigInt(usdWei(100)));
    expect(model.dailyVolume).toEqual([{ timestamp: Number(DAY), value: 150 }]);

    expect(model.v2Aggregated).toHaveLength(1);
    expect(model.v2Aggregated[0]?.trader).toBe(USER);
    expect(model.v2Aggregated[0]?.volumeUsdWei).toBe(BigInt(usdWei(70)));
    expect(model.v2DailyVolume).toEqual([
      { timestamp: Number(DAY), value: 100 },
    ]);
  });
});
