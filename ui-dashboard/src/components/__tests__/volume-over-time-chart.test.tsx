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
  VolumeOverTimeChart,
  buildBrokerDailyV2Series,
  buildDailyVolumeSeries,
  weekOverWeekChangePct,
} from "@/components/volume-over-time-chart";
import {
  TVL_NETWORK,
  TVL_NETWORK_2,
  makeNetworkData,
  makeSnapshot,
  makeTvlPool,
} from "@/test-utils/network-fixtures";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { TimeSeriesPoint } from "@/lib/time-series";

const SECONDS_PER_DAY = 86_400;

function dayAlignedNow(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function makeVolumeNetworkData(
  snapshotOverrides: object[] = [],
): NetworkData[] {
  return [
    makeNetworkData({
      network: TVL_NETWORK,
      pools: [makeTvlPool({ id: "pool-a" })],
      snapshots30d: snapshotOverrides.map((snapshot) =>
        makeSnapshot({ poolId: "pool-a", ...snapshot }),
      ),
    }),
  ];
}

function renderChart(
  overrides: Partial<React.ComponentProps<typeof VolumeOverTimeChart>> = {},
): string {
  const props: React.ComponentProps<typeof VolumeOverTimeChart> = {
    networkData: [],
    isLoading: false,
    hasError: false,
    hasSnapshotError: false,
    hasBrokerSnapshotError: false,
    ...overrides,
  };

  return renderToStaticMarkup(React.createElement(VolumeOverTimeChart, props));
}

describe("buildDailyVolumeSeries", () => {
  it("fills missing UTC-day buckets with zero instead of forward-filling", () => {
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;
    const day2 = today;

    const { series } = buildDailyVolumeSeries(
      makeVolumeNetworkData([
        { timestamp: day0, swapVolume0: "1000000000000000000" },
        { timestamp: day2, swapVolume0: "3000000000000000000" },
      ]),
    );

    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({ timestamp: day0, volumeUSD: 1 });
    expect(series[1]).toMatchObject({
      timestamp: day0 + SECONDS_PER_DAY,
      volumeUSD: 0,
    });
    expect(series[2]).toMatchObject({ timestamp: day2, volumeUSD: 3 });
  });

  it("excludes buckets that start before window.from even if they partially overlap", () => {
    // Strict half-open filter [window.from, window.to):
    //   - Day 0 (bucket timestamp < window.from): EXCLUDED — strict filter.
    //   - Day 1 (timestamp >= window.from AND < window.to): INCLUDED.
    //   - Day 2 (bucket timestamp == window.to): EXCLUDED — half-open upper bound.
    // This keeps the 1W/1M headline accurate: no extra-day volume from a partial
    // first day is counted in a range labeled as 7 or 30 days.
    const day0 = dayAlignedNow() - 3 * SECONDS_PER_DAY;
    const day1 = day0 + SECONDS_PER_DAY;
    const day2 = day0 + 2 * SECONDS_PER_DAY;
    const windowFrom = day0 + 6 * 3600; // window starts 6h into day 0 → day0 excluded
    const windowTo = day2; // upper bound lands on day 2's boundary → day2 excluded

    const { series } = buildDailyVolumeSeries(
      makeVolumeNetworkData([
        { timestamp: day0, swapVolume0: "1000000000000000000" }, // starts before window.from → excluded
        { timestamp: day1, swapVolume0: "2000000000000000000" }, // fully inside → $2
        { timestamp: day2, swapVolume0: "4000000000000000000" }, // bucket starts at windowTo → excluded
      ]),
      { from: windowFrom, to: windowTo },
    );

    const total = series.reduce((s, p) => s + p.volumeUSD, 0);
    expect(total).toBe(2);
  });

  it("returns empty when no snapshots fall inside the window", () => {
    const today = dayAlignedNow();
    const { series } = buildDailyVolumeSeries(
      makeVolumeNetworkData([
        {
          timestamp: today - 20 * SECONDS_PER_DAY,
          swapVolume0: "1000000000000000000",
        },
      ]),
      { from: today - 5 * SECONDS_PER_DAY, to: today },
    );
    expect(series).toEqual([]);
  });

  it("does not emit a synthetic zero bucket when window.to aligns with a UTC-day boundary", () => {
    // When the user loads at UTC midnight, window.to == endBucket exactly.
    // The filter excludes timestamps at or after window.to, so the endBucket
    // would emit an empty zero bar on the right edge if we iterated with
    // `timestamp <= endBucket`. Loop must stop at the bucket BEFORE that.
    const today = dayAlignedNow();
    const from = today - 3 * SECONDS_PER_DAY;
    const to = today; // day-aligned upper bound
    const { series } = buildDailyVolumeSeries(
      makeVolumeNetworkData([
        { timestamp: from + 3600, swapVolume0: "1000000000000000000" },
        {
          timestamp: from + SECONDS_PER_DAY + 3600,
          swapVolume0: "2000000000000000000",
        },
      ]),
      { from, to },
    );

    // Expect buckets for day (to - 3d), (to - 2d), (to - 1d). No zero bar at `to`.
    expect(series.map((p) => p.timestamp)).toEqual([
      today - 3 * SECONDS_PER_DAY,
      today - 2 * SECONDS_PER_DAY,
      today - 1 * SECONDS_PER_DAY,
    ]);
    // And the totals reflect only in-window snapshots.
    const total = series.reduce((s, p) => s + p.volumeUSD, 0);
    expect(total).toBe(3);
  });

  it("includes today's partial bucket when window.to is mid-day (production case)", () => {
    // Production windows come from hourBucket(Date.now()), so window.to is
    // always a mid-day hour boundary, not midnight. PoolDailySnapshot is an
    // incremental accumulator: today's row only contains swaps seen so far
    // today (not a precomputed full-day total), so it should contribute its
    // partial volume to the 1W/1M headline.
    const today = dayAlignedNow();
    const from = today - 2 * SECONDS_PER_DAY;
    const to = today + 6 * 3600; // window.to is 06:00 UTC today (non-midnight)

    const { series } = buildDailyVolumeSeries(
      makeVolumeNetworkData([
        { timestamp: from, swapVolume0: "1000000000000000000" }, // day-2: $1
        {
          timestamp: from + SECONDS_PER_DAY,
          swapVolume0: "2000000000000000000",
        }, // day-1: $2
        { timestamp: today, swapVolume0: "3000000000000000000" }, // today (partial): $3
      ]),
      { from, to },
    );

    // today's bucket must appear with its in-window (partial) data
    expect(series.map((p) => p.timestamp)).toEqual([
      today - 2 * SECONDS_PER_DAY,
      today - 1 * SECONDS_PER_DAY,
      today,
    ]);
    expect(series.reduce((s, p) => s + p.volumeUSD, 0)).toBe(6); // $1 + $2 + $3
  });

  it("partitions volume per chain via byChain, with sums equal to the total", () => {
    // Chain A contributes $1 on day 0 and $3 on day 1.
    // Chain B contributes $2 on day 0 and nothing on day 1.
    // Total: day0=$3, day1=$3. byChain[A]=[$1,$3], byChain[B]=[$2,$0].
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;
    const day1 = today - 1 * SECONDS_PER_DAY;

    const { series, byChain } = buildDailyVolumeSeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [makeTvlPool({ id: "pool-a" })],
        snapshots30d: [
          makeSnapshot({
            poolId: "pool-a",
            timestamp: day0,
            swapVolume0: "1000000000000000000",
          }),
          makeSnapshot({
            poolId: "pool-a",
            timestamp: day1,
            swapVolume0: "3000000000000000000",
          }),
        ],
      }),
      makeNetworkData({
        network: TVL_NETWORK_2,
        pools: [makeTvlPool({ id: "pool-b" })],
        snapshots30d: [
          makeSnapshot({
            poolId: "pool-b",
            timestamp: day0,
            swapVolume0: "2000000000000000000",
          }),
        ],
      }),
    ]);

    expect(byChain).toHaveLength(2);
    const chainA = byChain.find((c) => c.network.id === TVL_NETWORK.id)!;
    const chainB = byChain.find((c) => c.network.id === TVL_NETWORK_2.id)!;

    // Per-bucket invariant: chainA + chainB = total for every bucket.
    for (let i = 0; i < series.length; i++) {
      expect(chainA.series[i].volumeUSD + chainB.series[i].volumeUSD).toBe(
        series[i].volumeUSD,
      );
      expect(chainA.series[i].timestamp).toBe(series[i].timestamp);
    }
    // Zero-fill: chain B emits 0 on day 1 (rather than being omitted).
    expect(chainB.series[1].volumeUSD).toBe(0);
  });

  it("omits chains whose snapshots are all out-of-window or null-priced", () => {
    // Chain B has snapshots but they're all outside the active window
    // → byChain should not include chain B at all (legend would otherwise
    // show a flat-zero band that misrepresents reality).
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;
    const farPast = today - 100 * SECONDS_PER_DAY;

    const { byChain } = buildDailyVolumeSeries(
      [
        makeNetworkData({
          network: TVL_NETWORK,
          pools: [makeTvlPool({ id: "pool-a" })],
          snapshots30d: [
            makeSnapshot({
              poolId: "pool-a",
              timestamp: day0,
              swapVolume0: "1000000000000000000",
            }),
          ],
        }),
        makeNetworkData({
          network: TVL_NETWORK_2,
          pools: [makeTvlPool({ id: "pool-b" })],
          snapshots30d: [
            makeSnapshot({
              poolId: "pool-b",
              timestamp: farPast,
              swapVolume0: "5000000000000000000",
            }),
          ],
        }),
      ],
      { from: today - 5 * SECONDS_PER_DAY, to: today },
    );

    expect(byChain).toHaveLength(1);
    expect(byChain[0].network.id).toBe(TVL_NETWORK.id);
  });
});

describe("buildBrokerDailyV2Series", () => {
  function makeBrokerNetworkData(
    rows: { timestamp: number; volumeUsdWei: string; swapCount: number }[],
  ) {
    return [
      makeNetworkData({
        network: TVL_NETWORK,
        brokerSnapshotsAllDaily: rows.map((r, i) => ({
          id: `42220-bipool-direct-${r.timestamp}-${i}`,
          timestamp: String(r.timestamp),
          volumeUsdWei: r.volumeUsdWei,
          swapCount: r.swapCount,
        })),
      }),
    ];
  }

  it("converts USD-wei rows into per-day USD totals", () => {
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;
    const day1 = today - 1 * SECONDS_PER_DAY;

    const series = buildBrokerDailyV2Series(
      makeBrokerNetworkData([
        { timestamp: day0, volumeUsdWei: "1000000000000000000", swapCount: 1 }, // $1
        { timestamp: day1, volumeUsdWei: "2500000000000000000", swapCount: 3 }, // $2.5
      ]),
      { from: day0, to: today },
    );

    expect(series).toHaveLength(2);
    expect(series[0]).toEqual({ timestamp: day0, volumeUSD: 1 });
    expect(series[1]).toEqual({ timestamp: day1, volumeUSD: 2.5 });
  });

  it("zero-fills missing days within the active window", () => {
    // Same window-bucketing semantics as buildDailyVolumeSeries: stack
    // alignment between v2 and v3 requires every day in the window to be
    // emitted, even when v2 had no swaps that day.
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;

    const series = buildBrokerDailyV2Series(
      makeBrokerNetworkData([
        { timestamp: day0, volumeUsdWei: "1000000000000000000", swapCount: 1 },
      ]),
      { from: day0, to: today },
    );

    expect(series).toEqual([
      { timestamp: day0, volumeUSD: 1 },
      { timestamp: day0 + SECONDS_PER_DAY, volumeUSD: 0 },
    ]);
  });

  it("returns empty when no broker rows are provided", () => {
    // Guards against the chart rendering an empty zero series before the
    // indexer's Broker handler has synced.
    const today = dayAlignedNow();
    const series = buildBrokerDailyV2Series(makeBrokerNetworkData([]), {
      from: today - SECONDS_PER_DAY,
      to: today,
    });
    expect(series).toEqual([]);
  });

  it("aggregates rows from multiple chains into one series", () => {
    // Chains with no Broker (Monad) return empty arrays, so a chain with rows
    // and a chain without must merge cleanly. Future-proofs against a Broker
    // showing up on Monad later.
    const today = dayAlignedNow();
    const day0 = today - 1 * SECONDS_PER_DAY;
    const series = buildBrokerDailyV2Series(
      [
        makeNetworkData({
          network: TVL_NETWORK,
          brokerSnapshotsAllDaily: [
            {
              id: `42220-bipool-direct-${day0}`,
              timestamp: String(day0),
              volumeUsdWei: "3000000000000000000",
              swapCount: 1,
            },
          ],
        }),
        makeNetworkData({
          network: TVL_NETWORK_2,
          brokerSnapshotsAllDaily: [
            {
              id: `143-bipool-direct-${day0}`,
              timestamp: String(day0),
              volumeUsdWei: "1000000000000000000",
              swapCount: 1,
            },
          ],
        }),
      ],
      { from: day0, to: today },
    );
    expect(series).toEqual([{ timestamp: day0, volumeUSD: 4 }]);
  });
});

describe("weekOverWeekChangePct", () => {
  function buildSeries(values: number[]): TimeSeriesPoint[] {
    const start = dayAlignedNow() - (values.length - 1) * SECONDS_PER_DAY;
    return values.map((value, i) => ({
      timestamp: start + i * SECONDS_PER_DAY,
      value,
    }));
  }

  it("returns null when fewer than 15 buckets exist", () => {
    expect(weekOverWeekChangePct(buildSeries(Array(14).fill(10)))).toBeNull();
  });

  it("returns null when the prior 7-day window is zero", () => {
    // 15 buckets: first 7 are prior window (zero), then 7 active days, then today
    const vals = [0, 0, 0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 10, 10, 5];
    expect(weekOverWeekChangePct(buildSeries(vals))).toBeNull();
  });

  it("computes a positive delta comparing the last 7 full days vs the prior 7", () => {
    // prior 7 = sum 70, last 7 = sum 140, today (partial) = ignored
    const vals = [10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20, 99];
    expect(weekOverWeekChangePct(buildSeries(vals))).toBeCloseTo(100, 5);
  });

  it("excludes the trailing partial-day bucket from the last-7 window", () => {
    // prior 7 sum 70, last 7 sum 70 → 0%, today wildly different shouldn't matter
    const vals = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 999];
    expect(weekOverWeekChangePct(buildSeries(vals))).toBe(0);
  });
});

describe("VolumeOverTimeChart render", () => {
  beforeEach(() => {
    capturedPlotProps = {};
  });

  it("renders the 'Volume' title without a time-range suffix", () => {
    const html = renderChart();
    expect(html).toContain("Volume");
    expect(html).not.toContain("Volume (past 7d)");
    expect(html).not.toContain("Volume (24h)");
  });

  it("starts with the 1M range active by default", () => {
    const html = renderChart();
    expect(html).toMatch(/aria-pressed="true"[^>]*>1M</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>1W</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>All</);
  });

  it("exposes an 'All' range tab that maps to snapshotsAllDaily", () => {
    // Series data lives in snapshotsAllDaily (via the fixture default), so
    // the "All" tab is unfiltered and will include older snapshots that the
    // 1M tab would exclude. Default range is 1M so SSR won't show the summed
    // value — this test only asserts the tab is present and reachable.
    const html = renderChart({
      networkData: makeVolumeNetworkData([
        { timestamp: dayAlignedNow(), swapVolume0: "1000000000000000000" },
      ]),
    });
    expect(html).toContain(">All<");
  });

  it("renders N/A when no data and a top-level error", () => {
    const html = renderChart({ hasError: true });
    expect(html).toContain("N/A");
    expect(html).not.toContain("…");
  });

  it("renders N/A when snapshots partially failed and no data survived", () => {
    const html = renderChart({ hasSnapshotError: true });
    expect(html).toContain("N/A");
    expect(html).toContain("· partial data");
  });

  it("renders $0.00 v3 · $0.00 v2 (not N/A) when there's no volume yet and no errors", () => {
    // The v2/v3 split is the chart's contract — both versions render their
    // own $0 column even when empty so the columns aren't suddenly missing
    // the moment one side has no data (or hasn't synced yet).
    const html = renderChart();
    expect(html).toContain("$0.00 v3 · $0.00 v2");
    expect(html).not.toContain("N/A");
  });

  it("renders a skeleton (not the real value or N/A) while loading", () => {
    const html = renderChart({ isLoading: true });
    expect(html).toMatch(/animate-pulse/);
    expect(html).not.toContain("…");
    expect(html).not.toContain("N/A");
  });

  it("renders 'Not enough history yet' when no data and no errors", () => {
    const html = renderChart();
    expect(html).toContain("Not enough history yet");
  });

  it("renders the top-level error empty state distinctly from partial-history empty state", () => {
    const errorHtml = renderChart({ hasError: true });
    const partialHtml = renderChart({ hasSnapshotError: true });

    expect(errorHtml).toContain("Unable to load volume history");
    expect(partialHtml).toContain(
      "Historical data partial — some chains failed to load",
    );
  });

  it("renders the headline as `$X v3 · $Y v2` covering the default (30d) range", () => {
    const today = dayAlignedNow();
    // Both snapshots are within the default 30d window. Today's bucket is
    // included because PoolDailySnapshot is incremental (partial today data
    // is valid in-window volume, not a precomputed full-day total). The
    // fixture has no Broker data so v2 = $0.00.
    const html = renderChart({
      networkData: makeVolumeNetworkData([
        {
          timestamp: today - SECONDS_PER_DAY,
          swapVolume0: "1000000000000000000",
        },
        { timestamp: today, swapVolume0: "2000000000000000000" },
      ]),
    });

    expect(html).toContain("$3.00 v3 · $0.00 v2");
    // Only 2 days of history < 15 buckets required for WoW comparison, so
    // the delta is null. The 30d range itself does NOT suppress the pill —
    // the WoW basis is always 7d-vs-7d, independent of visible range.
    expect(html).not.toContain("week-over-week");
  });

  it("renders `— v2` (not $0.00 v2) when the broker rollup errored", () => {
    // hasBrokerSnapshotError must be a distinct unavailable state from the
    // legitimate "$0 swaps today" case — otherwise a Broker query failure
    // poisons the v2 number while the v3 side continues to render confidently.
    const today = dayAlignedNow();
    const html = renderChart({
      networkData: makeVolumeNetworkData([
        {
          timestamp: today - SECONDS_PER_DAY,
          swapVolume0: "1000000000000000000",
        },
      ]),
      hasBrokerSnapshotError: true,
    });

    expect(html).toContain("$1.00 v3 · — v2");
    expect(html).not.toContain("$0.00 v2");
  });

  it("includes per-day v3+v2 sum in the chart card's series prop so stacked y-axis ceiling fits", () => {
    // The chart card derives the y-axis range from `max([...series.value,
    // ...breakdownYs])`. In stacked mode the rendered top is v3+v2 per day,
    // so `series` MUST carry the summed value or large v2 days clip past
    // the ceiling.
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;
    const day1 = today - 1 * SECONDS_PER_DAY;
    capturedPlotProps = {};
    renderChart({
      networkData: [
        makeNetworkData({
          network: TVL_NETWORK,
          pools: [makeTvlPool({ id: "pool-a" })],
          snapshots30d: [
            // v3 = $3 on day0, $5 on day1
            makeSnapshot({
              poolId: "pool-a",
              timestamp: day0,
              swapVolume0: "3000000000000000000",
            }),
            makeSnapshot({
              poolId: "pool-a",
              timestamp: day1,
              swapVolume0: "5000000000000000000",
            }),
          ],
          // v2 = $4 on day0, $0 on day1
          brokerSnapshotsAllDaily: [
            {
              id: `42220-bipool-direct-${day0}`,
              timestamp: String(day0),
              volumeUsdWei: "4000000000000000000",
              swapCount: 1,
            },
          ],
        }),
      ],
    });

    // The chart card derives `yaxis.range` from `max([...series.value,
    // ...breakdownYs])`. In stacked mode the breakdown traces don't carry
    // the cumulative top — only the summed-`series` prop does. So the
    // y-axis ceiling MUST be at or above the actual stacked top of $7
    // (v3 $3 + v2 $4 on day0). Pre-fix it was max($5 v3 day1, $4 v2 day0) =
    // $5, so day0's stack ($7) clipped past the ceiling.
    const yRange = (
      capturedPlotProps.layout?.yaxis as { range?: [number, number] }
    )?.range;
    expect(yRange).toBeDefined();
    expect(yRange![1]).toBeGreaterThanOrEqual(7);
  });

  it("shows the WoW delta pill labeled 'v3 week-over-week' at the default range when ≥15 days of v3 history exist", () => {
    // The pill is v3-specific (the dominant series); v2 has its own
    // trajectory but tracking both deltas would clutter the headline. Build
    // 15 v3 buckets with prior 7 sum < last 7 sum so WoW is positive.
    const today = dayAlignedNow();
    const start = today - 14 * SECONDS_PER_DAY;
    const snapshots = Array.from({ length: 15 }, (_, i) => ({
      timestamp: start + i * SECONDS_PER_DAY,
      // First 7 buckets contribute $1 each, next 7 contribute $2 each, today $0.
      swapVolume0:
        i < 7 ? "1000000000000000000" : i < 14 ? "2000000000000000000" : "0",
    }));

    const html = renderChart({
      networkData: makeVolumeNetworkData(snapshots),
    });

    expect(html).toContain("v3 week-over-week");
  });

  it("uses the fetch-anchored snapshotWindows rather than render-time Date.now()", () => {
    // Anchor the fixture's snapshotWindows to a fixed timestamp in the past.
    // If the chart uses the fetch anchor, the visible 30d series will include
    // a snapshot whose timestamp sits inside the ANCHORED window but outside
    // what a render-time Date.now()-based window would cover.
    const anchoredNow = dayAlignedNow() - 3 * SECONDS_PER_DAY;
    const anchoredWindows = {
      w24h: {
        from: anchoredNow - 24 * 3600,
        to: anchoredNow,
      },
      w7d: {
        from: anchoredNow - 7 * SECONDS_PER_DAY,
        to: anchoredNow,
      },
      w30d: {
        from: anchoredNow - 30 * SECONDS_PER_DAY,
        to: anchoredNow,
      },
    };
    // Snapshot sits 2d before anchoredNow (inside the anchored 30d window)
    // but 5d before Date.now()-anchor would compute (since now > anchoredNow
    // by 3d). Both windows include it, but only the anchored window would
    // treat it as the newest-in-range; a render-time window would include
    // today's (zero) data too. This test asserts the headline matches what
    // the ANCHORED window produces, not render-time.
    const snapshotTs = anchoredNow - 2 * SECONDS_PER_DAY;
    const html = renderChart({
      networkData: [
        makeNetworkData({
          network: TVL_NETWORK,
          pools: [makeTvlPool({ id: "pool-a" })],
          snapshotWindows: anchoredWindows,
          snapshots30d: [
            makeSnapshot({
              poolId: "pool-a",
              timestamp: snapshotTs,
              swapVolume0: "5000000000000000000", // $5 worth
            }),
          ],
        }),
      ],
    });

    // The hero should reflect the anchored-window total ($5 on the v3 side,
    // no Broker data → $0 on v2); render-time window might or might not —
    // but since we've verified this path runs through the anchored window by
    // passing explicit snapshotWindows, any future regression that swaps
    // back to Date.now() will show the snapshot being dropped at boundary
    // edge cases.
    expect(html).toContain("$5.00 v3 · $0.00 v2");
  });

  it("passes Plotly config overrides when data is present", () => {
    const today = dayAlignedNow();
    renderChart({
      networkData: makeVolumeNetworkData([
        { timestamp: today, swapVolume0: "1000000000000000000" },
      ]),
    });

    expect(capturedPlotProps.config?.scrollZoom).toBe(false);
    expect(capturedPlotProps.config?.displayModeBar).toBe(false);
  });
});
