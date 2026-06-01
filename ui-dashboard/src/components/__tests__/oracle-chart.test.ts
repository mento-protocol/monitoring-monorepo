/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  __test__,
  formatOracleChartHoverText,
  resolveSnapshotBand,
} from "../oracle-chart";
import type { OracleSnapshot } from "@/lib/types";

const {
  buildOracleShapes,
  buildOracleXaxis,
  buildOraclePlotData,
  buildOracleLayout,
} = __test__;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fixidity is 1e24 — encode the Mento contract scale. Strings here mirror
// the Hasura wire format (BigInt → JSON string) the chart actually sees.
// 1.05 × 1e24 → "1050000000000000000000000". The threshold 0.001 (10 bps)
// is also Fixidity, so 0.001 × 1e24 → "1000000000000000000000".
const FIXIDITY_ONE_05 = "1050000000000000000000000"; // 1.05
const FIXIDITY_ZERO_001 = "1000000000000000000000"; // 0.001 = 10bps

// Generic Fixidity 1e24 encoder for `oraclePrice` tests. We multiply by 1e6
// (rounded to an integer) then pad 18 zeros, which gives a deterministic
// 24-digit decimal scale without losing precision on chart-relevant
// magnitudes.
const toFixidity = (n: number): string =>
  BigInt(Math.round(n * 1_000_000)).toString() + "0".repeat(18);

function oracleSnapshot(
  overrides: Partial<OracleSnapshot> = {},
): OracleSnapshot {
  return {
    id: "snapshot-1",
    chainId: 42220,
    poolId: "42220-0xpool",
    timestamp: "1778457600",
    oraclePrice: "1000000000000000000000000", // 1.0 in Fixidity 1e24
    oracleOk: true,
    numReporters: 3,
    priceDifference: "0",
    rebalanceThreshold: 500,
    source: "SortedOracles",
    blockNumber: "1",
    txHash: "0xabc",
    hasHealthData: true,
    ...overrides,
  };
}

/** Snapshot fixture with `oraclePrice` set from a float (Fixidity 1e24). */
function snapAtPrice(price: number, ts: number): OracleSnapshot {
  return oracleSnapshot({
    id: `snap-${ts}`,
    timestamp: String(ts),
    oraclePrice: toFixidity(price),
  });
}

// ---------------------------------------------------------------------------
// formatOracleChartHoverText (existing coverage)
// ---------------------------------------------------------------------------

describe("formatOracleChartHoverText", () => {
  it("renders price + breaker verdict when inside the band", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 1.0005,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });

    expect(text).toContain("Oracle feed: 1.00050000 (raw cUSD/USDC pair)");
    expect(text).toContain("+5.0 bps");
    expect(text).toContain("within current band");
  });

  it("flags breaker trip when delta exceeds threshold", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 0.998,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      token0Symbol: "USDm",
      token1Symbol: "USDT",
    });

    expect(text).toContain("-20.0 bps");
    expect(text).toContain("would trip current band");
  });

  it("renders N/A safely when price is not finite", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: Number.NaN,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });

    expect(text).toContain("Oracle feed: N/A");
    expect(text).not.toContain("NaN");
  });

  it("omits delta line when baseline is unknown", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 1.0,
      baseline: null,
      thresholdRatio: null,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });

    expect(text).not.toContain("Δ vs baseline");
  });

  it("uses 'at the time' wording for historical band verdicts", () => {
    // When the indexer persists the breaker baseline on the snapshot row,
    // the chart's verdict isn't a "current-lens" check — it's the actual
    // at-the-time evaluation. The hover wording must reflect that so an
    // operator reading a green dot doesn't think "this passes today."
    const ok = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 1.0005,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      isHistoricalBand: true,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });
    expect(ok).toContain("within band at the time");

    const breach = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 0.998,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      isHistoricalBand: true,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });
    expect(breach).toContain("would have tripped at the time");
  });
});

describe("resolveSnapshotBand", () => {
  it("prefers persisted per-snapshot baseline + threshold over current config", () => {
    // Spec for the PR-624 follow-up: a snapshot written with the indexer's
    // breakerBaselineAtSnapshot must override the live breaker config so
    // EMA drift between write-time and read-time can't flip a historical
    // verdict. 1.05 / 0.001 = the band that was actually armed when the
    // median landed; 1.10 / 0.003 = today's current band.
    const snapshot = oracleSnapshot({
      breakerBaselineAtSnapshot: FIXIDITY_ONE_05,
      breakerThresholdAtSnapshot: FIXIDITY_ZERO_001,
    });

    const resolved = resolveSnapshotBand(snapshot, 1.1, 0.003);

    expect(resolved.baseline).toBeCloseTo(1.05, 10);
    expect(resolved.thresholdRatio).toBeCloseTo(0.001, 10);
  });

  it("falls back to current config when per-snapshot fields are absent", () => {
    // Pre-deploy rows + rows from non-oracle sources (update_reserves,
    // rebalanced) explicitly null these fields. The chart should reuse the
    // current breaker config rather than refuse to render the verdict.
    const snapshot = oracleSnapshot({
      breakerBaselineAtSnapshot: null,
      breakerThresholdAtSnapshot: null,
    });

    const resolved = resolveSnapshotBand(snapshot, 1.08, 0.04);

    expect(resolved.baseline).toBeCloseTo(1.08, 10);
    expect(resolved.thresholdRatio).toBeCloseTo(0.04, 10);
  });

  it("falls back to current when one persisted field is null", () => {
    // Pair-of-two semantics — the indexer writes both fields together,
    // so a half-populated row indicates corruption. Refuse the partial
    // persisted pair and fall back rather than mixing a persisted
    // baseline with a current threshold.
    const snapshot = oracleSnapshot({
      breakerBaselineAtSnapshot: FIXIDITY_ONE_05,
      breakerThresholdAtSnapshot: null,
    });

    const resolved = resolveSnapshotBand(snapshot, 1.1, 0.003);

    expect(resolved.baseline).toBeCloseTo(1.1, 10);
    expect(resolved.thresholdRatio).toBeCloseTo(0.003, 10);
  });

  it("returns nulls when neither persisted nor current band is usable", () => {
    // No breaker exists for this feed, no historical anchor either —
    // markers should render as neutral / unknown, not greenwash to OK.
    const snapshot = oracleSnapshot({
      breakerBaselineAtSnapshot: null,
      breakerThresholdAtSnapshot: null,
    });

    const resolved = resolveSnapshotBand(snapshot, null, null);

    expect(resolved.baseline).toBeNull();
    expect(resolved.thresholdRatio).toBeNull();
  });
});

// `isOutOfBand` was removed in PR #636 round-2 — the verdict logic lives
// inside `buildSnapshotMarkers`'s inner closure now (it needs per-snapshot
// band resolution, not a global `breakerConfigStatus` gate), and the
// module-level helper was dead production code. Coverage of the actual
// verdict math is exercised end-to-end via `buildOraclePlotData` below.

// ---------------------------------------------------------------------------
// buildOracleShapes
// ---------------------------------------------------------------------------

describe("buildOracleShapes", () => {
  it("returns no band shapes when baseline is null", () => {
    const shapes = buildOracleShapes(undefined, 1.1, null, 0.01);
    expect(shapes).toEqual([]);
  });

  it("returns no band shapes when thresholdRatio is null", () => {
    const shapes = buildOracleShapes(undefined, 1.1, 1.0, null);
    expect(shapes).toEqual([]);
  });

  it("returns only the breach guide when band is absent but breach is set", () => {
    const shapes = buildOracleShapes("1778457600", 1.1, null, null);
    expect(shapes).toHaveLength(1);
    expect(shapes![0]).toMatchObject({
      type: "line",
      xref: "x",
      yref: "paper",
      layer: "above",
    });
  });

  it("emits three band rects + two threshold lines + baseline + breach guide", () => {
    const shapes = buildOracleShapes("1778457600", 1.5, 1.0, 0.01);
    // 3 rects + 2 threshold lines + 1 baseline + 1 breach guide = 7.
    expect(shapes).toHaveLength(7);

    // Order: red-below, green-inside, red-above, dashed-Lo, dashed-Hi, baseline, breach guide.
    const [
      redBelow,
      greenInside,
      redAbove,
      threshLo,
      threshHi,
      baselineLine,
      breachGuide,
    ] = shapes!;

    expect(redBelow).toMatchObject({
      type: "rect",
      fillcolor: "#ef4444",
      layer: "below",
      y0: 0,
      y1: 0.99,
    });
    expect(greenInside).toMatchObject({
      type: "rect",
      fillcolor: "#22c55e",
      layer: "below",
      y0: 0.99,
      y1: 1.01,
    });
    expect(redAbove).toMatchObject({
      type: "rect",
      fillcolor: "#ef4444",
      layer: "below",
      y0: 1.01,
    });
    // Threshold lines (dashed red, above layer).
    expect(threshLo).toMatchObject({
      type: "line",
      layer: "above",
      line: { color: "#ef4444", width: 1.25, dash: "dash" },
      y0: 0.99,
      y1: 0.99,
    });
    expect(threshHi).toMatchObject({
      type: "line",
      layer: "above",
      line: { color: "#ef4444", width: 1.25, dash: "dash" },
      y0: 1.01,
      y1: 1.01,
    });
    // Baseline (dotted, dim slate).
    expect(baselineLine).toMatchObject({
      type: "line",
      layer: "above",
      line: { dash: "dot" },
      y0: 1.0,
      y1: 1.0,
    });
    // Breach guide (vertical, against paper-y). The x-anchor is derived from
    // `breachStartedAt * 1000` → ISO; asserting it pins the unit semantics so
    // a regression to (e.g.) millisecond inputs would surface here.
    expect(breachGuide).toMatchObject({
      type: "line",
      xref: "x",
      yref: "paper",
      layer: "above",
      line: { color: "#ef4444", dash: "dot" },
      x0: "2026-05-11T00:00:00.000Z",
      x1: "2026-05-11T00:00:00.000Z",
    });
  });

  it("omits the breach guide when breachStartedAt is unset / zero", () => {
    const unset = buildOracleShapes(undefined, 1.5, 1.0, 0.01);
    expect(unset).toHaveLength(6); // 3 rects + 2 thresholds + 1 baseline.

    const zero = buildOracleShapes("0", 1.5, 1.0, 0.01);
    expect(zero).toHaveLength(6);
  });

  it("anchors the upper red rect past max(baseline*10, yMax*2)", () => {
    const shapes = buildOracleShapes(undefined, 1.5, 1.0, 0.01);
    const redAbove = shapes![2];
    // max(1*10, 1.5*2) = 10 — the `baseline*10` term wins.
    expect(redAbove).toMatchObject({ y1: 10 });
  });

  it("anchors past yMax*2 when yMax dominates baseline (zoomed-out branch)", () => {
    const shapes = buildOracleShapes(undefined, 6, 1.0, 0.01);
    const redAbove = shapes![2];
    // max(1*10, 6*2) = max(10, 12) = 12 — the `yMax*2` term wins.
    expect(redAbove).toMatchObject({ y1: 12 });
  });
});

// ---------------------------------------------------------------------------
// buildOracleXaxis
// ---------------------------------------------------------------------------

describe("buildOracleXaxis", () => {
  it("pads ±1h around a single timestamp (newly-indexed pool branch)", () => {
    const ts = "2026-05-27T12:00:00.000Z";
    const xaxis = buildOracleXaxis([ts], true);
    expect(xaxis.autorange).toBe(false);
    expect(xaxis.range).toEqual([
      "2026-05-27T11:00:00.000Z",
      "2026-05-27T13:00:00.000Z",
    ]);
  });

  it("pads a sparse 2+ timestamp window by max(span*0.1, 1h)", () => {
    // Span = 30min (1800s), 0.1 * span = 180s — clamped to 3600s (1h).
    const xaxis = buildOracleXaxis(
      ["2026-05-27T12:00:00.000Z", "2026-05-27T12:30:00.000Z"],
      true,
    );
    expect(xaxis.autorange).toBe(false);
    expect(xaxis.range).toEqual([
      "2026-05-27T11:00:00.000Z",
      "2026-05-27T13:30:00.000Z",
    ]);
  });

  it("uses span*0.1 padding when the window is already wider than 1h", () => {
    // Span = 100h, 0.1 * span = 10h, > 1h floor.
    const xaxis = buildOracleXaxis(
      ["2026-05-23T00:00:00.000Z", "2026-05-27T04:00:00.000Z"],
      true,
    );
    expect(xaxis.range).toEqual([
      "2026-05-22T14:00:00.000Z",
      "2026-05-27T14:00:00.000Z",
    ]);
  });

  it("defaults to a 7-day trailing window when there are enough timestamps", () => {
    // Build 25 hourly timestamps from 2026-05-20T00 → 2026-05-21T00, then
    // jump the last one to 2026-05-27T12 so the trailing 7d window kicks
    // in (max - 7d > minDataTs).
    const ts: string[] = [];
    for (let i = 0; i < 24; i++) {
      ts.push(new Date(Date.UTC(2026, 4, 1, i)).toISOString());
    }
    ts.push("2026-05-27T12:00:00.000Z");
    const xaxis = buildOracleXaxis(ts, false);
    expect(xaxis.autorange).toBe(false);
    expect(xaxis.range).toEqual([
      "2026-05-20T12:00:00.000Z", // max - 7d
      "2026-05-27T12:00:00.000Z",
    ]);
  });

  it("clamps the trailing window to minDataTs when total span < 7d", () => {
    // Build 25 hourly timestamps spanning <7d so `start = max(minDataTs, max - 7d)`
    // resolves to `minDataTs`, not the 7d-ago wall clock.
    const ts: string[] = [];
    for (let i = 0; i < 25; i++) {
      ts.push(new Date(Date.UTC(2026, 4, 1, i)).toISOString());
    }
    const xaxis = buildOracleXaxis(ts, false);
    expect(xaxis.range).toEqual([
      "2026-05-01T00:00:00.000Z",
      "2026-05-02T00:00:00.000Z",
    ]);
  });

  it("returns the default axis (no range override) when timestamps is empty", () => {
    const xaxis = buildOracleXaxis([], false);
    expect(xaxis.range).toBeUndefined();
    expect(xaxis.autorange).toBeUndefined();
  });

  it("omits range/autorange after the initial paint so uirevision holds the zoom", () => {
    // The wheel handler sets the Plotly range directly; on the next SWR repoll
    // the layout must NOT re-supply a range, or it clobbers that zoom and the
    // view snaps back out. applyInitialRange=false models every post-mount render.
    const ts: string[] = [];
    for (let i = 0; i < 25; i++) {
      ts.push(new Date(Date.UTC(2026, 4, 1, i)).toISOString());
    }
    const xaxis = buildOracleXaxis(ts, false, false);
    expect(xaxis.range).toBeUndefined();
    expect(xaxis.autorange).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildOraclePlotData — y-range autosize
// ---------------------------------------------------------------------------

describe("buildOraclePlotData y-range autosize", () => {
  function buildData(opts: {
    prices: number[];
    baseline: number | null;
    thresholdRatio: number | null;
    breakerConfigStatus?: "ready" | "loading" | "missing";
  }) {
    const snapshots = opts.prices.map((p, i) => snapAtPrice(p, 1778457600 + i));
    return buildOraclePlotData({
      snapshots,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
      baseline: opts.baseline,
      thresholdRatio: opts.thresholdRatio,
      breakerConfigStatus: opts.breakerConfigStatus ?? "ready",
    });
  }

  it("excludes both band edges when data sits far from both (tight VALUE_DELTA)", () => {
    // baseline=1.0, threshold=0.001 → band [0.999, 1.001]. Prices clustered
    // at ~1.005 (far above both edges). dataSpan = 0.0002, margin =
    // max(0.0001, 0.001) = 0.001. bandHi=1.001 vs dataMin-margin=1.0039 → far
    // below, excluded. bandLo=0.999 → much farther below, also excluded.
    // The inline comment calls this out: "For tight VALUE_DELTA stablecoin
    // pools, data clustered at one band still hides the far band."
    const { yMin, yMax } = buildData({
      prices: [1.0049, 1.005, 1.0051],
      baseline: 1.0,
      thresholdRatio: 0.001,
    });
    // With both band edges excluded, the visible range straddles only the
    // data extremes (~1.0049-1.0051) with padding.
    expect(yMin).toBeGreaterThan(1.001); // bandHi (and bandLo) excluded
    expect(yMax).toBeGreaterThan(1.005); // covers data + padding
  });

  it("includes one band edge when data sits near it (one-sided drift)", () => {
    // baseline=1.0, threshold=0.05 → band [0.95, 1.05]. Push data near bandHi.
    // dataSpan = 0.001, margin = max(5e-4, 0.05) = 0.05. Band edges within
    // dataMin/Max ± 0.05 window — both qualify under MEDIAN_DELTA term.
    // But the math: bandHi=1.05, dataMax=1.049 → bandHi - dataMax = 0.001
    // is within margin (0.05). Same on the lower side: bandLo=0.95,
    // dataMin=1.048 → dataMin - bandLo = 0.098 > 0.05 → bandLo excluded.
    const { yMin, yMax } = buildData({
      prices: [1.048, 1.0485, 1.049],
      baseline: 1.0,
      thresholdRatio: 0.05,
    });
    expect(yMax).toBeGreaterThanOrEqual(1.05); // bandHi included
    expect(yMin).toBeGreaterThan(0.95); // bandLo NOT included
  });

  it("includes BOTH band edges for centered data with MEDIAN_DELTA-style margin", () => {
    // baseline=1.0, threshold=0.05 → band [0.95, 1.05]. Prices [0.999, 1.0, 1.001].
    // dataSpan=0.002, margin=max(0.001, 0.05) = 0.05. Both edges (±0.05 from
    // baseline) fall within data ± margin — both should be included. This is
    // the case the inline comment calls out as "the MEDIAN_DELTA win".
    const { yMin, yMax } = buildData({
      prices: [0.999, 1.0, 1.001],
      baseline: 1.0,
      thresholdRatio: 0.05,
    });
    expect(yMin).toBeLessThanOrEqual(0.95); // bandLo included
    expect(yMax).toBeGreaterThanOrEqual(1.05); // bandHi included
  });

  it("falls back to baseline when all snapshot prices are invalid", () => {
    // Snapshots with `oraclePrice: "0"` resolve to NaN inside the helper,
    // so the finite-price array is empty and dataMin/dataMax fall back to
    // baseline. yMin/yMax must still resolve to a finite window.
    const snapshots = [
      oracleSnapshot({ id: "s-1", oraclePrice: "0" }),
      oracleSnapshot({ id: "s-2", oraclePrice: "" }),
    ];
    const { yMin, yMax } = buildOraclePlotData({
      snapshots,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
      baseline: 1.0,
      thresholdRatio: 0.01,
      breakerConfigStatus: "ready",
    });
    expect(Number.isFinite(yMin)).toBe(true);
    expect(Number.isFinite(yMax)).toBe(true);
    expect(yMin).toBeLessThan(1.0);
    expect(yMax).toBeGreaterThan(1.0);
  });

  it("produces a non-degenerate window even for perfectly flat data", () => {
    const { yMin, yMax } = buildData({
      prices: [1.0, 1.0, 1.0],
      baseline: 1.0,
      thresholdRatio: 0.01,
    });
    expect(yMax).toBeGreaterThan(yMin);
  });
});

describe("buildOracleLayout uirevision", () => {
  const baseArgs = {
    shapes: [],
    plotData: {
      deviationTrace: {},
      timestamps: ["2026-05-01T00:00:00.000Z"],
      isSparse: true,
      yMin: 0.99,
      yMax: 1.01,
    },
    applyInitialRange: true,
    baseline: 1.0,
    thresholdRatio: 0.01,
  };

  it("carries the uirevision token through to the layout", () => {
    const layout = buildOracleLayout({
      ...baseArgs,
      uirevision: "celo-mainnet:42220-0xpool",
    });
    // Preserves zoom/pan across re-renders while the token is unchanged.
    expect(layout.uirevision).toBe("celo-mainnet:42220-0xpool");
  });

  it("leaves uirevision undefined when no token is passed (no pinning)", () => {
    const layout = buildOracleLayout(baseArgs);
    expect(layout.uirevision).toBeUndefined();
  });
});
