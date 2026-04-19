/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OracleSnapshot, Pool } from "@/lib/types";
import {
  ORACLE_SNAPSHOT_PREDECESSOR,
  ORACLE_SNAPSHOTS_WINDOW,
} from "@/lib/queries";

// Mocks — useGQL is the only external dependency of the hook.

const useGQLMock = vi.fn();
vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => useGQLMock(...args),
}));

// Neutralise weekend arithmetic. Synthetic test windows are anchored to
// `Date.now()`; when the real calendar lands on a weekend, the FX-weekend
// subtraction inside `tradingSecondsInRange` shrinks those windows enough
// to zero out the denominator and force `score === null`, flipping this
// suite red on Saturdays/Sundays.
vi.mock("@/lib/weekend", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/weekend")>("@/lib/weekend");
  return {
    ...actual,
    isWeekend: () => false,
    weekendOverlapSeconds: () => 0,
    tradingSecondsInRange: (start: number, end: number) => end - start,
  };
});

import { useHealthScore, type HealthScoreResult } from "../use-health-score";

// Mount a throwaway component that captures the hook's result into `captured`.
function captureHookResult(pool: Pool): {
  result: HealthScoreResult;
  unmount: () => void;
  container: HTMLDivElement;
  root: Root;
} {
  const captured: { value: HealthScoreResult | null } = { value: null };
  function Probe({ p }: { p: Pool }) {
    captured.value = useHealthScore(p);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe, { p: pool }));
  });
  if (!captured.value) throw new Error("hook did not capture a result");
  return {
    result: captured.value,
    unmount: () => root.unmount(),
    container,
    root,
  };
}

function makeSnapshot(
  partial: Partial<OracleSnapshot> & { timestamp: string; id?: string },
): OracleSnapshot {
  return {
    id: partial.id ?? `snap-${partial.timestamp}`,
    chainId: 42220,
    poolId: "42220-0xpool",
    timestamp: partial.timestamp,
    oraclePrice: partial.oraclePrice ?? "1000000000000000000000000",
    oracleOk: partial.oracleOk ?? true,
    numReporters: partial.numReporters ?? 3,
    priceDifference: partial.priceDifference ?? "0",
    rebalanceThreshold: partial.rebalanceThreshold ?? 1000,
    source: partial.source ?? "fpmm_factory",
    blockNumber: partial.blockNumber ?? "1",
    txHash: partial.txHash ?? "0xabc",
    deviationRatio: partial.deviationRatio ?? "0",
    healthBinaryValue: partial.healthBinaryValue ?? "1",
    hasHealthData: partial.hasHealthData ?? true,
  };
}

const BASE_POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
  oracleExpiry: "300",
};

beforeEach(() => {
  useGQLMock.mockReset();
});

describe("useHealthScore — virtual pools", () => {
  it("returns null scores and does not invoke useGQL for virtual pools", () => {
    // Default implementation: all `useGQL` calls return empty — but the hook
    // should short-circuit via `shouldFetch` so the mock must never be asked
    // with a non-null query. We still provide a safe fallback here to avoid
    // a crash if the guard regresses.
    useGQLMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });

    const virtualPool: Pool = { ...BASE_POOL, source: "virtual" };
    const { result, unmount } = captureHookResult(virtualPool);

    expect(result.healthWindow.score).toBeNull();
    expect(result.allTimeScore).toBeNull();
    expect(result.error).toBeNull();
    // Both GQL calls were made, but with null query (shouldFetch=false).
    // Verify neither was asked to fetch ORACLE_SNAPSHOTS_WINDOW / PREDECESSOR.
    const fetchedQueries = useGQLMock.mock.calls
      .map((call) => call[0])
      .filter((q) => q != null);
    expect(fetchedQueries).toHaveLength(0);
    unmount();
  });
});

describe("useHealthScore — non-virtual pools", () => {
  it("returns null rolling window score when no snapshots are available", () => {
    useGQLMock.mockImplementation((query: string | null) => {
      if (query == null) return { data: undefined, error: undefined };
      return {
        data: { OracleSnapshot: [] },
        error: undefined,
      };
    });

    const { result, unmount } = captureHookResult(BASE_POOL);
    expect(result.healthWindow.score).toBeNull();
    // With no snapshots and no all-time data, overall score is null but not an error.
    expect(result.allTimeScore).toBeNull();
    expect(result.error).toBeNull();
    unmount();
  });

  it("returns a computed score when in-window snapshots are available", () => {
    const now = Math.floor(Date.now() / 60_000) * 60; // minute-aligned seconds
    // Two healthy snapshots within the rolling window.
    const snapshots = [
      makeSnapshot({
        timestamp: String(now - 23 * 3600),
        healthBinaryValue: "1",
      }),
      makeSnapshot({
        timestamp: String(now - 12 * 3600),
        healthBinaryValue: "1",
      }),
    ];
    useGQLMock.mockImplementation((query: string | null) => {
      if (query === ORACLE_SNAPSHOTS_WINDOW) {
        return { data: { OracleSnapshot: snapshots }, error: undefined };
      }
      if (query === ORACLE_SNAPSHOT_PREDECESSOR) {
        return { data: { OracleSnapshot: [] }, error: undefined };
      }
      return { data: undefined, error: undefined };
    });

    const { result, unmount } = captureHookResult(BASE_POOL);
    expect(result.healthWindow.score).not.toBeNull();
    expect(result.error).toBeNull();
    unmount();
  });

  it("narrows effectiveWindowStart when snapshots exceed HEALTH_WINDOW_LIMIT", () => {
    // Construct 1001 snapshots so normalizeWindowSnapshots reports truncated=true.
    const now = Math.floor(Date.now() / 60_000) * 60;
    const snapshots: OracleSnapshot[] = [];
    for (let i = 0; i < 1001; i++) {
      // Timestamps span a window; the newest (i=0) is most recent.
      snapshots.push(
        makeSnapshot({
          id: `s-${i}`,
          timestamp: String(now - i * 60),
          healthBinaryValue: "1",
        }),
      );
    }
    useGQLMock.mockImplementation((query: string | null) => {
      if (query === ORACLE_SNAPSHOTS_WINDOW) {
        return { data: { OracleSnapshot: snapshots }, error: undefined };
      }
      if (query === ORACLE_SNAPSHOT_PREDECESSOR) {
        return { data: { OracleSnapshot: [] }, error: undefined };
      }
      return { data: undefined, error: undefined };
    });

    const { result, unmount } = captureHookResult(BASE_POOL);
    // When truncated, the score is still computed over the narrower window
    // but observedHours is bounded by the kept span. Verify we didn't crash
    // and that the score is a finite fraction.
    expect(result.healthWindow.score).not.toBeNull();
    expect(Number.isFinite(result.healthWindow.observedHours)).toBe(true);
    // HealthScoreValue's period-label degradation keys off `truncated` —
    // without this flag the UI would still render the nominal "7d" copy
    // even though the covered window is shorter. Lock the contract here.
    expect(result.truncated).toBe(true);
    expect(result.nominalWindowSeconds).toBe(7 * 24 * 3600);
    // Observed span is bounded by the kept 1000 snapshots spaced 1 min
    // apart ≈ 1000 minutes ≈ 16.67 hours, far below the 168h nominal.
    expect(result.healthWindow.observedHours).toBeLessThan(24);
    unmount();
  });

  it("reports truncated=false when snapshots fit under the HEALTH_WINDOW_LIMIT", () => {
    // Symmetric lower-bound case so the contract is pinned on both sides.
    const now = Math.floor(Date.now() / 60_000) * 60;
    const snapshots: OracleSnapshot[] = [];
    for (let i = 0; i < 10; i++) {
      snapshots.push(
        makeSnapshot({
          id: `s-${i}`,
          timestamp: String(now - i * 60),
          healthBinaryValue: "1",
        }),
      );
    }
    useGQLMock.mockImplementation((query: string | null) => {
      if (query === ORACLE_SNAPSHOTS_WINDOW) {
        return { data: { OracleSnapshot: snapshots }, error: undefined };
      }
      if (query === ORACLE_SNAPSHOT_PREDECESSOR) {
        return { data: { OracleSnapshot: [] }, error: undefined };
      }
      return { data: undefined, error: undefined };
    });

    const { result, unmount } = captureHookResult(BASE_POOL);
    expect(result.truncated).toBe(false);
    unmount();
  });
});

describe("useHealthScore — allTimeScore", () => {
  it("is healthBinarySeconds/healthTotalSeconds when hasHealthData is true", () => {
    useGQLMock.mockReturnValue({
      data: { OracleSnapshot: [] },
      error: undefined,
    });
    const pool: Pool = {
      ...BASE_POOL,
      hasHealthData: true,
      healthBinarySeconds: "3600",
      healthTotalSeconds: "7200",
    };
    const { result, unmount } = captureHookResult(pool);
    expect(result.allTimeScore).toBeCloseTo(0.5, 6);
    unmount();
  });

  it("is null when hasHealthData is false", () => {
    useGQLMock.mockReturnValue({
      data: { OracleSnapshot: [] },
      error: undefined,
    });
    const pool: Pool = {
      ...BASE_POOL,
      hasHealthData: false,
      healthBinarySeconds: "3600",
      healthTotalSeconds: "7200",
    };
    const { result, unmount } = captureHookResult(pool);
    expect(result.allTimeScore).toBeNull();
    unmount();
  });

  it("is null when healthTotalSeconds is zero", () => {
    useGQLMock.mockReturnValue({
      data: { OracleSnapshot: [] },
      error: undefined,
    });
    const pool: Pool = {
      ...BASE_POOL,
      hasHealthData: true,
      healthBinarySeconds: "0",
      healthTotalSeconds: "0",
    };
    const { result, unmount } = captureHookResult(pool);
    expect(result.allTimeScore).toBeNull();
    unmount();
  });
});

describe("useHealthScore — error coalescing", () => {
  it("surfaces windowError when the window query rejects", () => {
    const boom = new Error("window failed");
    useGQLMock.mockImplementation((query: string | null) => {
      if (query === ORACLE_SNAPSHOTS_WINDOW) {
        return { data: undefined, error: boom };
      }
      if (query === ORACLE_SNAPSHOT_PREDECESSOR) {
        return { data: { OracleSnapshot: [] }, error: undefined };
      }
      return { data: undefined, error: undefined };
    });

    const { result, unmount } = captureHookResult(BASE_POOL);
    expect(result.error).toBe(boom);
    unmount();
  });

  it("surfaces predecessorError when only the predecessor query rejects", () => {
    const boom = new Error("predecessor failed");
    useGQLMock.mockImplementation((query: string | null) => {
      if (query === ORACLE_SNAPSHOTS_WINDOW) {
        return { data: { OracleSnapshot: [] }, error: undefined };
      }
      if (query === ORACLE_SNAPSHOT_PREDECESSOR) {
        return { data: undefined, error: boom };
      }
      return { data: undefined, error: undefined };
    });

    const { result, unmount } = captureHookResult(BASE_POOL);
    expect(result.error).toBe(boom);
    unmount();
  });
});
