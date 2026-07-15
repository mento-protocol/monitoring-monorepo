/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TvlOverTimeChart } from "@/components/tvl-over-time-chart";
import {
  VolumeOverTimeChart,
  buildDailyVolumeSeries,
} from "@/components/volume-over-time-chart";
import {
  TVL_NETWORK,
  makeNetworkData,
  makeSnapshot,
  makeTvlPool,
} from "@/test-utils/network-fixtures";
import type { NetworkData } from "@/hooks/use-all-networks-data";

type CapturedTrace = { name?: string; x?: unknown[] };
let capturedPlots: CapturedTrace[][] = [];

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot({ data }: { data?: CapturedTrace[] }) {
      if (data) capturedPlots.push(data);
      return React.createElement("div", { "data-testid": "plot" });
    },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  capturedPlots = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function historyData(capped: boolean): NetworkData[] {
  const pool = makeTvlPool({ id: "pool-a" });
  return [
    makeNetworkData({
      network: TVL_NETWORK,
      pools: [pool],
      snapshotsAllDaily: [makeSnapshot({ poolId: pool.id })],
      snapshotsAllDailyCapped: capped,
    }),
  ];
}

function rangeButton(label: string, range: string): HTMLButtonElement {
  const group = container.querySelector(`[aria-label="${label}"]`);
  const button = Array.from(group?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent === range,
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe("homepage snapshot history range handoff", () => {
  it("requests full history and hides the capped TVL series until uncapped data arrives", () => {
    const requestFullSnapshotHistory = vi.fn(async () => undefined);
    const render = (networkData: NetworkData[], capped: boolean) => {
      act(() => {
        root.render(
          <TvlOverTimeChart
            networkData={networkData}
            totalTvl={2}
            tvlPartial={false}
            change7d={null}
            isLoading={false}
            hasError={false}
            hasSnapshotError={false}
            snapshotHistoryCapped={capped}
            snapshotHistoryError={null}
            requestFullSnapshotHistory={requestFullSnapshotHistory}
          />,
        );
      });
    };
    render(historyData(true), true);
    expect(container.querySelector('[data-testid="plot"]')).not.toBeNull();

    act(() => {
      rangeButton("TVL chart time range", "All").click();
    });

    expect(requestFullSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(
      rangeButton("TVL chart time range", "All").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).toContain(
      "Total Value Locked chart is loading.",
    );
    expect(container.querySelector('[data-testid="plot"]')).toBeNull();

    render(historyData(false), false);

    expect(container.textContent).not.toContain(
      "Total Value Locked chart is loading.",
    );
    expect(container.querySelector('[data-testid="plot"]')).not.toBeNull();
    expect(requestFullSnapshotHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps TVL All available when only Broker history is capped", () => {
    const requestFullSnapshotHistory = vi.fn(async () => undefined);
    const networkData = historyData(false).map((data) => ({
      ...data,
      brokerSnapshotsAllDailyCapped: true,
      brokerSnapshotsAllDailyTruncated: true,
    }));
    act(() => {
      root.render(
        <TvlOverTimeChart
          networkData={networkData}
          totalTvl={2}
          tvlPartial={false}
          change7d={null}
          isLoading={false}
          hasError={false}
          hasSnapshotError={false}
          snapshotHistoryCapped={false}
          snapshotHistoryError={null}
          requestFullSnapshotHistory={requestFullSnapshotHistory}
        />,
      );
    });

    act(() => {
      rangeButton("TVL chart time range", "All").click();
    });

    expect(requestFullSnapshotHistory).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(
      "Total Value Locked chart is loading.",
    );
    expect(container.querySelector('[data-testid="plot"]')).not.toBeNull();
  });

  it("uses Broker cap state when a Volume caller omits the combined override", () => {
    const requestFullSnapshotHistory = vi.fn(async () => undefined);
    const networkData = historyData(false).map((data) => ({
      ...data,
      brokerSnapshotsAllDailyCapped: true,
    }));
    act(() => {
      root.render(
        <VolumeOverTimeChart
          networkData={networkData}
          isLoading={false}
          hasError={false}
          hasSnapshotError={false}
          hasBrokerSnapshotError={false}
          fullVolumeSeries={buildDailyVolumeSeries(networkData)}
          snapshotHistoryError={null}
          requestFullSnapshotHistory={requestFullSnapshotHistory}
        />,
      );
    });

    act(() => {
      rangeButton("Volume chart time range", "All").click();
    });

    expect(requestFullSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Volume chart is loading.");
    expect(container.querySelector('[data-testid="plot"]')).toBeNull();
  });

  it("shows an explicit error instead of plotting capped volume as All", () => {
    const networkData = historyData(true);
    const requestFullSnapshotHistory = vi.fn(async () => undefined);
    const render = (snapshotHistoryError: Error | null) => {
      act(() => {
        root.render(
          <VolumeOverTimeChart
            networkData={networkData}
            isLoading={false}
            hasError={false}
            hasSnapshotError={false}
            hasBrokerSnapshotError={false}
            fullVolumeSeries={buildDailyVolumeSeries(networkData)}
            snapshotHistoryCapped
            snapshotHistoryError={snapshotHistoryError}
            requestFullSnapshotHistory={requestFullSnapshotHistory}
          />,
        );
      });
    };
    render(null);

    act(() => {
      rangeButton("Volume chart time range", "All").click();
    });
    render(new Error("full history timeout"));

    expect(requestFullSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "Unable to load full volume history",
    );
    expect(container.textContent).not.toContain("Volume chart is loading.");
    expect(container.querySelector('[data-testid="plot"]')).toBeNull();
  });

  it("plots an older Broker sentinel after a Broker-only capped All request completes", () => {
    const today = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
    const recentRow = {
      id: "broker-recent",
      timestamp: String(today - 86_400),
      volumeUsdWei: "1000000000000000000",
      swapCount: 1,
    };
    const olderRow = {
      id: "broker-older-sentinel",
      timestamp: String(today - 40 * 86_400),
      volumeUsdWei: "42000000000000000000",
      swapCount: 42,
    };
    const requestFullSnapshotHistory = vi.fn(async () => undefined);
    const render = (networkData: NetworkData[], capped: boolean) => {
      act(() => {
        root.render(
          <VolumeOverTimeChart
            networkData={networkData}
            isLoading={false}
            hasError={false}
            hasSnapshotError={false}
            hasBrokerSnapshotError={false}
            fullVolumeSeries={buildDailyVolumeSeries(networkData)}
            snapshotHistoryCapped={capped}
            snapshotHistoryError={null}
            requestFullSnapshotHistory={requestFullSnapshotHistory}
          />,
        );
      });
    };
    const bounded = [
      makeNetworkData({
        snapshotsAllDailyCapped: false,
        brokerSnapshotsAllDaily: [recentRow],
        brokerSnapshotsAllDailyCapped: true,
      }),
    ];
    render(bounded, true);

    act(() => {
      rangeButton("Volume chart time range", "All").click();
    });
    expect(requestFullSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="plot"]')).toBeNull();

    const complete = [
      makeNetworkData({
        snapshotsAllDailyCapped: false,
        brokerSnapshotsAllDaily: [recentRow, olderRow],
        brokerSnapshotsAllDailyCapped: false,
      }),
    ];
    render(complete, false);

    const olderIso = new Date(Number(olderRow.timestamp) * 1000).toISOString();
    const v2Trace = capturedPlots
      .flat()
      .find((trace) => trace.name === "v2" && trace.x?.includes(olderIso));
    expect(v2Trace).toBeDefined();
    expect(container.querySelector('[data-testid="plot"]')).not.toBeNull();
  });
});
