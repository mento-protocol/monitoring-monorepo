/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POOL_DAILY_SNAPSHOTS_CHART,
  POOL_HOURLY_SNAPSHOTS_CHART,
} from "@/lib/queries";
import {
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  type RangeKey,
} from "@/lib/time-series";
import type { PoolSnapshot } from "@/lib/types";
import { SNAPSHOT_REFRESH_MS, snapshotWindow30d } from "@/lib/volume";
import {
  usePoolSnapshots,
  type PoolSnapshotsMode,
} from "../use-pool-snapshots";

const { useGQLMock } = vi.hoisted(() => ({
  useGQLMock: vi.fn(),
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => useGQLMock(...args),
}));

type HookResult = ReturnType<typeof usePoolSnapshots>;
type GqlResult = {
  data?:
    | { PoolSnapshot?: PoolSnapshot[]; PoolDailySnapshot?: PoolSnapshot[] }
    | undefined;
  error?: Error | undefined;
  isLoading: boolean;
};

const snapshot = (id: string, timestamp: string): PoolSnapshot => ({
  id,
  poolId: "pool-1",
  timestamp,
  reserves0: "1000000000000000000",
  reserves1: "2000000000000000000",
  swapCount: 0,
  swapVolume0: "0",
  swapVolume1: "0",
  rebalanceCount: 0,
  cumulativeSwapCount: 0,
  cumulativeVolume0: "0",
  cumulativeVolume1: "0",
  blockNumber: timestamp,
});

function result(data: GqlResult["data"]): GqlResult {
  return { data, isLoading: false };
}

function installResults({
  hourlyResult,
  dailyResult,
}: {
  hourlyResult: GqlResult;
  dailyResult: GqlResult;
}) {
  useGQLMock.mockImplementation((query: unknown) => {
    if (query === null) return { isLoading: false };
    if (query === POOL_HOURLY_SNAPSHOTS_CHART) return hourlyResult;
    if (query === POOL_DAILY_SNAPSHOTS_CHART) return dailyResult;
    throw new Error(`Unexpected query: ${String(query)}`);
  });
}

function installResponses({
  hourlyRows,
  dailyRows,
}: {
  hourlyRows: PoolSnapshot[];
  dailyRows: PoolSnapshot[];
}) {
  installResults({
    hourlyResult: result({ PoolSnapshot: hourlyRows }),
    dailyResult: result({ PoolDailySnapshot: dailyRows }),
  });
}

function Probe({
  resultRef,
  range,
  mode,
}: {
  resultRef: { current: HookResult | null };
  range: RangeKey;
  mode: PoolSnapshotsMode;
}) {
  resultRef.current = usePoolSnapshots("pool-1", range, true, mode);
  return null;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-06T12:34:00Z"));
  useGQLMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

function render(
  range: RangeKey,
  mode: PoolSnapshotsMode = "flow",
): {
  ref: { current: HookResult | null };
  rerender: (nextRange?: RangeKey) => void;
} {
  const ref: { current: HookResult | null } = { current: null };
  const rerender = (nextRange = range) =>
    act(() => {
      root.render(<Probe resultRef={ref} range={nextRange} mode={mode} />);
    });
  rerender();
  return { ref, rerender };
}

function latestHourlyFrom(): number {
  const hourlyCall = useGQLMock.mock.calls.findLast(
    (call) => call[0] === POOL_HOURLY_SNAPSHOTS_CHART,
  );
  expect(hourlyCall).toBeDefined();
  return (hourlyCall![1] as { from: number }).from;
}

describe("usePoolSnapshots", () => {
  it("prefers hourly short-range rows while still fetching daily fallback rows", () => {
    const hourlyRows = [snapshot("hourly-1", "1700003600")];
    const dailyRows = [snapshot("daily-1", "1700000000")];
    installResponses({ hourlyRows, dailyRows });

    const { ref } = render("30d");

    expect(ref.current?.snapshots).toBe(hourlyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_HOUR);
    expect(useGQLMock).toHaveBeenCalledWith(
      POOL_HOURLY_SNAPSHOTS_CHART,
      { poolId: "pool-1", from: expect.any(Number) },
      SNAPSHOT_REFRESH_MS,
    );
    expect(useGQLMock).toHaveBeenCalledWith(
      POOL_DAILY_SNAPSHOTS_CHART,
      { poolId: "pool-1" },
      SNAPSHOT_REFRESH_MS,
    );
  });

  it("prepends the latest pre-window daily baseline for stock short-range rows", () => {
    const hourlyFrom = snapshotWindow30d(Date.now()).from;
    const hourlyRows = [
      snapshot("hourly-1", String(hourlyFrom + SECONDS_PER_HOUR)),
    ];
    const olderBaseline = snapshot(
      "daily-older",
      String(hourlyFrom - 2 * SECONDS_PER_DAY),
    );
    const latestBaseline = snapshot(
      "daily-latest-baseline",
      String(hourlyFrom - SECONDS_PER_DAY),
    );
    const afterWindowStart = snapshot(
      "daily-after-window-start",
      String(hourlyFrom + SECONDS_PER_DAY),
    );
    installResponses({
      hourlyRows,
      dailyRows: [afterWindowStart, olderBaseline, latestBaseline],
    });

    const { ref } = render("30d", "stock");

    expect(ref.current?.snapshots).toEqual([latestBaseline, ...hourlyRows]);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_HOUR);
  });

  it("keeps stock short-range rows loading until the daily baseline query settles", () => {
    const hourlyFrom = snapshotWindow30d(Date.now()).from;
    const hourlyRows = [
      snapshot("hourly-1", String(hourlyFrom + SECONDS_PER_HOUR)),
    ];
    installResults({
      hourlyResult: result({ PoolSnapshot: hourlyRows }),
      dailyResult: { isLoading: true },
    });

    const { ref } = render("30d", "stock");

    expect(ref.current?.snapshots).toBe(hourlyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_HOUR);
    expect(ref.current?.isLoading).toBe(true);
  });

  it("does not merge a pre-window daily baseline for flow short-range rows", () => {
    const hourlyFrom = snapshotWindow30d(Date.now()).from;
    const hourlyRows = [
      snapshot("hourly-1", String(hourlyFrom + SECONDS_PER_HOUR)),
    ];
    const dailyRows = [
      snapshot("daily-baseline", String(hourlyFrom - SECONDS_PER_DAY)),
    ];
    installResponses({ hourlyRows, dailyRows });

    const { ref } = render("30d");

    expect(ref.current?.snapshots).toBe(hourlyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_HOUR);
  });

  it("does not keep flow short-range rows loading while the daily fallback is pending", () => {
    const hourlyFrom = snapshotWindow30d(Date.now()).from;
    const hourlyRows = [
      snapshot("hourly-1", String(hourlyFrom + SECONDS_PER_HOUR)),
    ];
    installResults({
      hourlyResult: result({ PoolSnapshot: hourlyRows }),
      dailyResult: { isLoading: true },
    });

    const { ref } = render("30d");

    expect(ref.current?.snapshots).toBe(hourlyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_HOUR);
    expect(ref.current?.isLoading).toBe(false);
  });

  it("falls back to daily rows and daily bucketing when short-range hourly rows are empty", () => {
    const dailyRows = [snapshot("daily-1", "1700000000")];
    installResponses({ hourlyRows: [], dailyRows });

    const { ref } = render("30d");

    expect(ref.current?.snapshots).toBe(dailyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_DAY);
    expect(ref.current?.hasError).toBe(false);
  });

  it("falls back to daily rows without error when the hourly query fails", () => {
    const dailyRows = [snapshot("daily-1", "1700000000")];
    installResults({
      hourlyResult: { error: new Error("hourly down"), isLoading: false },
      dailyResult: result({ PoolDailySnapshot: dailyRows }),
    });

    const { ref } = render("30d");

    expect(ref.current?.snapshots).toBe(dailyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_DAY);
    expect(ref.current?.isLoading).toBe(false);
    expect(ref.current?.hasError).toBe(false);
  });

  it("keeps loading while the daily fallback is still loading after an hourly error", () => {
    installResults({
      hourlyResult: { error: new Error("hourly down"), isLoading: false },
      dailyResult: { isLoading: true },
    });

    const { ref } = render("30d");

    expect(ref.current?.snapshots).toEqual([]);
    expect(ref.current?.isLoading).toBe(true);
    expect(ref.current?.hasError).toBe(false);
  });

  it("uses only daily rows for long ranges", () => {
    const dailyRows = [snapshot("daily-1", "1700000000")];
    installResponses({ hourlyRows: [], dailyRows });

    const { ref } = render("all");

    expect(ref.current?.snapshots).toBe(dailyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_DAY);
    expect(useGQLMock).not.toHaveBeenCalledWith(
      POOL_HOURLY_SNAPSHOTS_CHART,
      expect.anything(),
      SNAPSHOT_REFRESH_MS,
    );
  });

  it("keeps the hourly from filter stable within the current hour", () => {
    installResponses({
      hourlyRows: [snapshot("hourly-1", "1700003600")],
      dailyRows: [snapshot("daily-1", "1700000000")],
    });

    const { rerender } = render("30d");
    const initialFrom = latestHourlyFrom();
    vi.setSystemTime(new Date("2026-07-06T12:59:59Z"));
    rerender();

    expect(latestHourlyFrom()).toBe(initialFrom);
  });

  it("refreshes the hourly from filter when the current hour changes", () => {
    installResponses({
      hourlyRows: [snapshot("hourly-1", "1700003600")],
      dailyRows: [snapshot("daily-1", "1700000000")],
    });

    const { rerender } = render("30d");
    const initialFrom = latestHourlyFrom();
    vi.setSystemTime(new Date("2026-07-06T13:00:00Z"));
    rerender();

    expect(latestHourlyFrom()).toBeGreaterThan(initialFrom);
  });
});
