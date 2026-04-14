import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let capturedPlotProps: {
  data?: unknown;
  layout?: Record<string, unknown>;
  config?: Record<string, unknown>;
} = {};

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot(props: {
      data: unknown;
      layout: Record<string, unknown>;
      config: Record<string, unknown>;
    }) {
      capturedPlotProps = props;
      return React.createElement("div", { "data-testid": "plot" });
    },
}));

import {
  TvlOverTimeChart,
  buildDailySeries,
} from "@/components/tvl-over-time-chart";
import {
  TVL_NETWORK,
  TVL_NETWORK_2,
  makeNetworkData,
  makeSnapshot,
  makeTvlPool,
} from "@/test-utils/network-fixtures";

const SECONDS_PER_DAY = 86_400;

function dayAlignedNow(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

const TEN = "10000000000000000000"; //  10 tokens
const TWENTY = "20000000000000000000"; //  20
const FIFTY = "50000000000000000000"; //  50
const HUNDRED = "100000000000000000000"; // 100
const TWO_HUNDRED = "200000000000000000000"; // 200

describe("buildDailySeries — empty / error short-circuits", () => {
  it("returns empty series and nowTvl=0 when networkData is empty", () => {
    const out = buildDailySeries([]);
    expect(out).toEqual({ series: [], nowTvl: 0 });
  });

  it("skips networks with a top-level error and returns nothing", () => {
    const today = dayAlignedNow();
    const pool = makeTvlPool({ reserves0: HUNDRED, reserves1: HUNDRED });
    const snap = makeSnapshot({
      timestamp: today,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const out = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [snap],
        error: new Error("mainnet down"),
      }),
    ]);
    expect(out).toEqual({ series: [], nowTvl: 0 });
  });

  it("skips networks with a snapshotsAllError and returns nothing", () => {
    const today = dayAlignedNow();
    const pool = makeTvlPool({ reserves0: HUNDRED, reserves1: HUNDRED });
    const snap = makeSnapshot({
      timestamp: today,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const out = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshotsAll: [snap],
        snapshotsAllError: new Error("snapshots timeout"),
      }),
    ]);
    expect(out).toEqual({ series: [], nowTvl: 0 });
  });
});

describe("buildDailySeries — pool filtering", () => {
  it("drops non-FPMM pools even when they have snapshots", () => {
    const today = dayAlignedNow();
    // source="VirtualPool" → isFpmm=false → dropped from histories
    const pool = makeTvlPool({
      id: "virtual-pool",
      reserves0: HUNDRED,
      reserves1: HUNDRED,
      source: "VirtualPool",
    });
    const snap = makeSnapshot({
      poolId: "virtual-pool",
      timestamp: today,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const out = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [snap],
      }),
    ]);
    expect(out).toEqual({ series: [], nowTvl: 0 });
  });

  it("drops FPMM pools without snapshots (new-pool-inflation guard)", () => {
    // FPMM pool with live reserves but NO snapshot → excluded from both series
    // and nowTvl. This is the critical invariant the chart relies on so a newly
    // deployed pool cannot cause a phantom right-edge cliff.
    const pool = makeTvlPool({
      id: "new-pool",
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const out = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [],
      }),
    ]);
    expect(out).toEqual({ series: [], nowTvl: 0 });
  });
});

describe("buildDailySeries — forward-fill across days", () => {
  it("uses latest snapshot <= bucket and forward-fills gaps", () => {
    // 5-day window: snapshots at day 0 and day 3. Live reserves differ from
    // both snapshots so we can verify buckets use snapshot values, not live.
    const today = dayAlignedNow();
    const day0 = today - 4 * SECONDS_PER_DAY;
    const day3 = today - 1 * SECONDS_PER_DAY; // today-1 day = day 3 of 5
    const pool = makeTvlPool({ reserves0: TEN, reserves1: TEN }); // live = $20
    // Day-0 snapshot: 100+100 = $200
    // Day-3 snapshot: 200+200 = $400
    const snapDay0 = makeSnapshot({
      timestamp: day0,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const snapDay3 = makeSnapshot({
      timestamp: day3,
      reserves0: TWO_HUNDRED,
      reserves1: TWO_HUNDRED,
    });

    const { series, nowTvl } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [snapDay0, snapDay3],
      }),
    ]);

    // 5 buckets: day 0, 1, 2, 3, 4(=today)
    expect(series).toHaveLength(5);
    expect(series[0].timestamp).toBe(day0);
    expect(series[4].timestamp).toBe(today);
    // Days 0,1,2 → day-0 snapshot reserves → $200
    expect(series[0].tvlUSD).toBeCloseTo(200, 6);
    expect(series[1].tvlUSD).toBeCloseTo(200, 6);
    expect(series[2].tvlUSD).toBeCloseTo(200, 6);
    // Day 3 → day-3 snapshot → $400 (cursor advanced to latest ≤ bucket)
    expect(series[3].tvlUSD).toBeCloseTo(400, 6);
    // Day 4 → forward-fill from day-3 → $400
    expect(series[4].tvlUSD).toBeCloseTo(400, 6);
    // nowTvl uses live reserves (10 + 10 = $20), not latest snapshot.
    expect(nowTvl).toBeCloseTo(20, 6);
  });

  it("picks the latest when two snapshots fall in the same bucket iteration", () => {
    // Pins the while-vs-if distinction: two snapshots in the SAME calendar-day
    // bucket. The cursor must advance twice in one iteration to land on the
    // later one. An `if` would stop at $200; the while-loop produces $100.
    const today = dayAlignedNow();
    const day0 = today - 1 * SECONDS_PER_DAY;
    const pool = makeTvlPool({ reserves0: TEN, reserves1: TEN });
    const earlier = makeSnapshot({
      timestamp: day0, // 00:00 on day0
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    }); // $200
    const later = makeSnapshot({
      timestamp: day0 + 3600, // 01:00 on day0 — same bucket
      reserves0: FIFTY,
      reserves1: FIFTY,
    }); // $100

    const { series } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [earlier, later],
      }),
    ]);

    // Buckets: day0, today (2 total; startDay = day0).
    expect(series).toHaveLength(2);
    expect(series[0].timestamp).toBe(day0);
    expect(series[0].tvlUSD).toBeCloseTo(100, 6);
    expect(series[1].tvlUSD).toBeCloseTo(100, 6);
  });

  it("uses the first snapshot's reserves for its calendar-day bucket (no synthetic zero)", () => {
    // Regression guard: if the cursor check used `<= t` (bucket start) instead
    // of `< t + SECONDS_PER_DAY` (bucket end), a mid-day first snapshot would
    // leave the first bucket at $0. Production snapshots are hour-aligned, so
    // the earliest in-range timestamp is virtually never exactly at midnight.
    const today = dayAlignedNow();
    const day0 = today - 1 * SECONDS_PER_DAY;
    const pool = makeTvlPool({ reserves0: TEN, reserves1: TEN });
    const snap = makeSnapshot({
      timestamp: day0 + 14 * 3600, // 14:00 on day0
      reserves0: FIFTY,
      reserves1: FIFTY,
    }); // $100

    const { series } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [snap],
      }),
    ]);

    expect(series[0].timestamp).toBe(day0);
    expect(series[0].tvlUSD).toBeCloseTo(100, 6);
  });

  it("places mid-day snapshot updates in the same calendar-day bucket", () => {
    // A change at 14:00 on day0 must appear in day0's bucket, not drift into
    // day1. Each bucket t covers the half-open interval [t, t + 86400).
    const today = dayAlignedNow();
    const day0 = today - 1 * SECONDS_PER_DAY;
    const pool = makeTvlPool({ reserves0: TEN, reserves1: TEN });
    const morning = makeSnapshot({
      timestamp: day0 + 3600, // 01:00
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    }); // $200
    const afternoon = makeSnapshot({
      timestamp: day0 + 14 * 3600, // 14:00 — same calendar day
      reserves0: FIFTY,
      reserves1: FIFTY,
    }); // $100

    const { series } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [morning, afternoon],
      }),
    ]);

    expect(series[0].timestamp).toBe(day0);
    expect(series[0].tvlUSD).toBeCloseTo(100, 6);
  });
});

describe("buildDailySeries — pools with mismatched snapshot start days", () => {
  it("contributes 0 for pools whose first snapshot is after a given bucket", () => {
    // Pool A has a day-0 snapshot, pool B's earliest snapshot is day 3.
    // Buckets 0–2 should reflect only pool A. Buckets 3–4 sum both.
    // nowTvl must include BOTH pools (they are both in histories).
    const today = dayAlignedNow();
    const day0 = today - 4 * SECONDS_PER_DAY;
    const day3 = today - 1 * SECONDS_PER_DAY;
    const poolA = makeTvlPool({
      id: "pool-a",
      reserves0: TEN,
      reserves1: TEN,
    }); // live A = $20
    const poolB = makeTvlPool({
      id: "pool-b",
      reserves0: TWENTY,
      reserves1: TWENTY,
    }); // live B = $40
    // Pool A day-0 snapshot: 100 + 100 = $200
    // Pool B day-3 snapshot: 50 + 50 = $100
    const snapA = makeSnapshot({
      poolId: "pool-a",
      timestamp: day0,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const snapB = makeSnapshot({
      poolId: "pool-b",
      timestamp: day3,
      reserves0: FIFTY,
      reserves1: FIFTY,
    });

    const { series, nowTvl } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [poolA, poolB],
        snapshots30d: [snapA, snapB],
      }),
    ]);

    expect(series).toHaveLength(5);
    // Days 0–2: only pool A contributes (B's cursor stays at -1 → skipped).
    expect(series[0].tvlUSD).toBeCloseTo(200, 6);
    expect(series[1].tvlUSD).toBeCloseTo(200, 6);
    expect(series[2].tvlUSD).toBeCloseTo(200, 6);
    // Days 3–4: A ($200) + B ($100) = $300.
    expect(series[3].tvlUSD).toBeCloseTo(300, 6);
    expect(series[4].tvlUSD).toBeCloseTo(300, 6);
    // nowTvl uses BOTH pools' live reserves: $20 + $40 = $60.
    expect(nowTvl).toBeCloseTo(60, 6);
  });
});

describe("buildDailySeries — input normalisation", () => {
  it("sorts snapshots by timestamp regardless of input order", () => {
    // Pass snapshots in reversed order — the internal sort must produce the
    // same series as the canonically ordered case.
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;
    const day1 = today - 1 * SECONDS_PER_DAY;
    const pool = makeTvlPool({ reserves0: TEN, reserves1: TEN });
    const s0 = makeSnapshot({
      timestamp: day0,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    }); // $200
    const s1 = makeSnapshot({
      timestamp: day1,
      reserves0: TWO_HUNDRED,
      reserves1: TWO_HUNDRED,
    }); // $400
    const s2 = makeSnapshot({
      timestamp: today,
      reserves0: FIFTY,
      reserves1: FIFTY,
    }); // $100

    // Reversed input.
    const { series } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [s2, s1, s0],
      }),
    ]);

    expect(series).toHaveLength(3);
    expect(series[0].tvlUSD).toBeCloseTo(200, 6); // day 0
    expect(series[1].tvlUSD).toBeCloseTo(400, 6); // day 1
    expect(series[2].tvlUSD).toBeCloseTo(100, 6); // today (latest)
  });
});

describe("buildDailySeries — nowTvl semantics", () => {
  it("uses live pool reserves, not the latest snapshot", () => {
    // Latest snapshot has 200+200 = $400, but live reserves are 10+10 = $20.
    // nowTvl must reflect pool.reserves0/1, not the snapshot.
    const today = dayAlignedNow();
    const pool = makeTvlPool({ reserves0: TEN, reserves1: TEN }); // live = $20
    const snap = makeSnapshot({
      timestamp: today,
      reserves0: TWO_HUNDRED,
      reserves1: TWO_HUNDRED,
    }); // $400
    const { nowTvl } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [snap],
      }),
    ]);
    expect(nowTvl).toBeCloseTo(20, 6);
  });

  it("excludes FPMM pools without snapshots from nowTvl", () => {
    // Pool A has snapshots (counted). Pool B is FPMM with live reserves but
    // no snapshot — must NOT contribute to nowTvl, matching the exclusion in
    // the series itself. Guards against the same new-pool-inflation concern.
    const today = dayAlignedNow();
    const poolA = makeTvlPool({
      id: "pool-a",
      reserves0: TEN,
      reserves1: TEN,
    }); // live A = $20
    const poolB = makeTvlPool({
      id: "pool-b",
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    }); // live B = $200
    const snapA = makeSnapshot({
      poolId: "pool-a",
      timestamp: today,
      reserves0: FIFTY,
      reserves1: FIFTY,
    }); // $100

    const { nowTvl } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [poolA, poolB],
        snapshots30d: [snapA], // only A has a snapshot
      }),
    ]);

    // nowTvl = pool A live ($20) only; pool B ($200) is excluded.
    expect(nowTvl).toBeCloseTo(20, 6);
  });
});

describe("buildDailySeries — multi-chain aggregation", () => {
  it("sums contributions from FPMM pools across multiple networks", () => {
    // Pool on chain A: live $20, day-0 snapshot $200
    // Pool on chain B: live $40, day-0 snapshot $100
    // Day-0 bucket total: $300. nowTvl: $60.
    const today = dayAlignedNow();
    const day0 = today - 1 * SECONDS_PER_DAY;
    const poolA = makeTvlPool({
      id: "pool-a",
      reserves0: TEN,
      reserves1: TEN,
    });
    const poolB = makeTvlPool({
      id: "pool-b",
      reserves0: TWENTY,
      reserves1: TWENTY,
    });
    const snapA = makeSnapshot({
      poolId: "pool-a",
      timestamp: day0,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const snapB = makeSnapshot({
      poolId: "pool-b",
      timestamp: day0,
      reserves0: FIFTY,
      reserves1: FIFTY,
    });

    const { series, nowTvl } = buildDailySeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [poolA],
        snapshots30d: [snapA],
      }),
      makeNetworkData({
        network: TVL_NETWORK_2,
        pools: [poolB],
        snapshots30d: [snapB],
      }),
    ]);

    expect(series).toHaveLength(2); // day 0 (yesterday) + today
    expect(series[0].timestamp).toBe(day0);
    expect(series[0].tvlUSD).toBeCloseTo(300, 6);
    // today forward-fills both chains.
    expect(series[1].tvlUSD).toBeCloseTo(300, 6);
    expect(nowTvl).toBeCloseTo(60, 6);
  });
});

// ---------------------------------------------------------------------------
// React render tests — exercises TvlOverTimeChart output. next/dynamic is
// mocked above so Plot renders as a sentinel div and its props are captured.
// ---------------------------------------------------------------------------

describe("TvlOverTimeChart render", () => {
  beforeEach(() => {
    capturedPlotProps = {};
  });

  it("renders 'Not enough history yet' when no data and no errors", () => {
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [
          makeNetworkData({
            network: TVL_NETWORK,
            pools: [],
            snapshots30d: [],
          }),
        ],
        totalTvl: 0,
        change7d: null,
        isLoading: false,
        hasError: false,
        hasSnapshotError: false,
      }),
    );
    expect(html).toContain("Not enough history yet");
    expect(html).not.toContain("Unable to load TVL history");
    expect(html).not.toContain("Historical data partial");
  });

  it("renders 'Unable to load TVL history' when hasError is true", () => {
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [],
        totalTvl: 0,
        change7d: null,
        isLoading: false,
        hasError: true,
        hasSnapshotError: false,
      }),
    );
    expect(html).toContain("Unable to load TVL history");
  });

  it("renders 'Historical data partial' when hasSnapshotError and series empty", () => {
    const today = dayAlignedNow();
    const pool = makeTvlPool({ reserves0: HUNDRED, reserves1: HUNDRED });
    const snap = makeSnapshot({
      timestamp: today,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [
          makeNetworkData({
            network: TVL_NETWORK,
            pools: [pool],
            snapshotsAll: [snap],
            snapshotsAllError: new Error("snapshots timeout"),
          }),
        ],
        totalTvl: 0,
        change7d: null,
        isLoading: false,
        hasError: false,
        hasSnapshotError: true,
      }),
    );
    expect(html).toContain("Historical data partial");
    expect(html).not.toContain("Unable to load TVL history");
    expect(html).not.toContain("Not enough history yet");
  });

  it("shows ellipsis headline when isLoading is true", () => {
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [],
        totalTvl: 1_234_567,
        change7d: null,
        isLoading: true,
        hasError: false,
        hasSnapshotError: false,
      }),
    );
    expect(html).toContain("\u2026");
    expect(html).not.toContain("$1.23M");
  });

  it("renders a positive delta pill in emerald", () => {
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [],
        totalTvl: 0,
        change7d: 2.13,
        isLoading: false,
        hasError: false,
        hasSnapshotError: false,
      }),
    );
    expect(html).toContain("+2.13%");
    expect(html).toContain("text-emerald-400");
    expect(html).not.toContain("text-red-400");
  });

  it("renders a negative delta pill in red", () => {
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [],
        totalTvl: 0,
        change7d: -5.14,
        isLoading: false,
        hasError: false,
        hasSnapshotError: false,
      }),
    );
    expect(html).toContain("-5.14%");
    expect(html).toContain("text-red-400");
    expect(html).not.toContain("text-emerald-400");
  });

  it("suppresses the delta pill and shows a partial badge when hasError is true", () => {
    // Regression guard: when one chain's top-level pools query fails, the
    // headline TVL is computed from the surviving subset. The delta pill must
    // disappear and the partial-data badge must surface so the user isn't
    // misled into treating the number as complete.
    const today = dayAlignedNow();
    const pool = makeTvlPool({ reserves0: HUNDRED, reserves1: HUNDRED });
    const snap = makeSnapshot({
      timestamp: today - SECONDS_PER_DAY,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [
          makeNetworkData({
            network: TVL_NETWORK,
            pools: [pool],
            snapshots30d: [snap],
          }),
        ],
        totalTvl: 200,
        change7d: 5.5,
        isLoading: false,
        hasError: true,
        hasSnapshotError: false,
      }),
    );
    expect(html).not.toContain("5.50%");
    expect(html).not.toContain("week-over-week");
    expect(html).toContain("· partial data");
  });

  it("renders no delta pill when change7d is null", () => {
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [],
        totalTvl: 0,
        change7d: null,
        isLoading: false,
        hasError: true,
        hasSnapshotError: false,
      }),
    );
    expect(html).not.toContain("text-emerald-400");
    expect(html).not.toContain("text-red-400");
    expect(html).not.toContain("week-over-week");
  });

  it("suppresses the delta pill while loading", () => {
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [],
        totalTvl: 0,
        change7d: 5.0,
        isLoading: true,
        hasError: false,
        hasSnapshotError: false,
      }),
    );
    expect(html).not.toContain("5.00%");
    expect(html).not.toContain("week-over-week");
  });

  it("starts with the 1M range active by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [],
        totalTvl: 0,
        change7d: null,
        isLoading: false,
        hasError: true,
        hasSnapshotError: false,
      }),
    );
    expect(html).toMatch(/aria-pressed="true"[^>]*>1M</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>1W</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>All</);
  });

  it("passes scrollZoom=false and displayModeBar=false to Plotly config", () => {
    const today = dayAlignedNow();
    const pool = makeTvlPool({ reserves0: HUNDRED, reserves1: HUNDRED });
    const snap = makeSnapshot({
      timestamp: today,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [
          makeNetworkData({
            network: TVL_NETWORK,
            pools: [pool],
            snapshots30d: [snap],
          }),
        ],
        totalTvl: 200,
        change7d: null,
        isLoading: false,
        hasError: false,
        hasSnapshotError: false,
      }),
    );
    expect(capturedPlotProps.config?.scrollZoom).toBe(false);
    expect(capturedPlotProps.config?.displayModeBar).toBe(false);
  });

  it("merges PLOTLY_BASE_LAYOUT with chart-local font override", () => {
    const today = dayAlignedNow();
    const pool = makeTvlPool({ reserves0: HUNDRED, reserves1: HUNDRED });
    const snap = makeSnapshot({
      timestamp: today,
      reserves0: HUNDRED,
      reserves1: HUNDRED,
    });
    renderToStaticMarkup(
      React.createElement(TvlOverTimeChart, {
        networkData: [
          makeNetworkData({
            network: TVL_NETWORK,
            pools: [pool],
            snapshots30d: [snap],
          }),
        ],
        totalTvl: 200,
        change7d: null,
        isLoading: false,
        hasError: false,
        hasSnapshotError: false,
      }),
    );
    expect(capturedPlotProps.layout?.paper_bgcolor).toBe("transparent");
    expect(capturedPlotProps.layout?.plot_bgcolor).toBe("transparent");
    const font = capturedPlotProps.layout?.font as
      | { size?: number }
      | undefined;
    expect(font?.size).toBe(11);
  });
});
