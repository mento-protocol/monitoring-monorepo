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
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import { usePoolSnapshots } from "../use-pool-snapshots";

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

function installResponses({
  hourlyRows,
  dailyRows,
}: {
  hourlyRows: PoolSnapshot[];
  dailyRows: PoolSnapshot[];
}) {
  useGQLMock.mockImplementation((query: unknown) => {
    if (query === null) return { isLoading: false };
    if (query === POOL_HOURLY_SNAPSHOTS_CHART) {
      return result({ PoolSnapshot: hourlyRows });
    }
    if (query === POOL_DAILY_SNAPSHOTS_CHART) {
      return result({ PoolDailySnapshot: dailyRows });
    }
    throw new Error(`Unexpected query: ${String(query)}`);
  });
}

function Probe({
  resultRef,
  range,
}: {
  resultRef: { current: HookResult | null };
  range: RangeKey;
}) {
  resultRef.current = usePoolSnapshots("pool-1", range, true);
  return null;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
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
});

function render(range: RangeKey): { current: HookResult | null } {
  const ref: { current: HookResult | null } = { current: null };
  act(() => {
    root.render(<Probe resultRef={ref} range={range} />);
  });
  return ref;
}

describe("usePoolSnapshots", () => {
  it("prefers hourly short-range rows while still fetching daily fallback rows", () => {
    const hourlyRows = [snapshot("hourly-1", "1700003600")];
    const dailyRows = [snapshot("daily-1", "1700000000")];
    installResponses({ hourlyRows, dailyRows });

    const ref = render("30d");

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

  it("falls back to daily rows and daily bucketing when short-range hourly rows are empty", () => {
    const dailyRows = [snapshot("daily-1", "1700000000")];
    installResponses({ hourlyRows: [], dailyRows });

    const ref = render("30d");

    expect(ref.current?.snapshots).toBe(dailyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_DAY);
    expect(ref.current?.hasError).toBe(false);
  });

  it("uses only daily rows for long ranges", () => {
    const dailyRows = [snapshot("daily-1", "1700000000")];
    installResponses({ hourlyRows: [], dailyRows });

    const ref = render("all");

    expect(ref.current?.snapshots).toBe(dailyRows);
    expect(ref.current?.bucketSeconds).toBe(SECONDS_PER_DAY);
    expect(useGQLMock).not.toHaveBeenCalledWith(
      POOL_HOURLY_SNAPSHOTS_CHART,
      expect.anything(),
      SNAPSHOT_REFRESH_MS,
    );
  });
});
