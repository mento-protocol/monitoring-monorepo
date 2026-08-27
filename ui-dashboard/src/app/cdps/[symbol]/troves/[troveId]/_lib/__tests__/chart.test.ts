import { describe, expect, it } from "vitest";
import {
  buildTroveChartSeries,
  markersInWindow,
  stepSeriesInWindow,
  TROVE_CHART_RANGES,
  troveChartRangeCutoff,
  type TroveChartPoint,
} from "../chart";
import type { CdpTroveLedgerEventRow } from "../ledger";

const D18 = BigInt(10) ** BigInt(18);
const DAY = 86_400;

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function ledgerRow(
  overrides: Partial<CdpTroveLedgerEventRow> = {},
): CdpTroveLedgerEventRow {
  return {
    id: "42220_100_1",
    operation: 2,
    collChange: "0",
    debtChange: "0",
    debtIncreaseFromUpfrontFee: "0",
    debtIncreaseFromRedist: "0",
    collIncreaseFromRedist: "0",
    annualInterestRate: "0",
    debtBefore: wei(1_000),
    debtAfter: wei(1_000),
    collBefore: wei(500),
    collAfter: wei(500),
    statusBefore: "active",
    statusAfter: "active",
    redemptionFeeCredited: null,
    isRebalance: null,
    redemptionPrice: null,
    priceAtEvent: null,
    icrAfterBps: null,
    timestamp: "1000",
    blockNumber: "100",
    logIndex: 1,
    txHash: "0xtx",
    ...overrides,
  };
}

function point(timestamp: number, value: number): TroveChartPoint {
  return { timestamp, value };
}

describe("troveChartRangeCutoff / TROVE_CHART_RANGES", () => {
  it("exposes the approved 1d/7d/30d/All pill set in order", () => {
    expect(TROVE_CHART_RANGES.map((item) => item.key)).toEqual([
      "1d",
      "7d",
      "30d",
      "all",
    ]);
    expect(TROVE_CHART_RANGES.map((item) => item.label)).toEqual([
      "1d",
      "7d",
      "30d",
      "All",
    ]);
  });

  it("computes day-window cutoffs from now, and null for all-history", () => {
    const now = 100 * DAY;
    expect(troveChartRangeCutoff("1d", now)).toBe(now - DAY);
    expect(troveChartRangeCutoff("7d", now)).toBe(now - 7 * DAY);
    expect(troveChartRangeCutoff("30d", now)).toBe(now - 30 * DAY);
    expect(troveChartRangeCutoff("all", now)).toBeNull();
  });
});

describe("buildTroveChartSeries", () => {
  it("orders vertices on the numeric triple regardless of input order", () => {
    const rows = [
      ledgerRow({
        id: "42220_300_0",
        timestamp: "3000",
        blockNumber: "300",
        logIndex: 0,
        collAfter: wei(30),
      }),
      ledgerRow({
        id: "42220_100_0",
        timestamp: "1000",
        blockNumber: "100",
        logIndex: 0,
        collAfter: wei(10),
      }),
      ledgerRow({
        id: "42220_200_0",
        timestamp: "2000",
        blockNumber: "200",
        logIndex: 0,
        collAfter: wei(20),
      }),
    ];
    const series = buildTroveChartSeries(rows, { debtSnapshotsComplete: true });
    expect(series.coll).toEqual([
      point(1000, 10),
      point(2000, 20),
      point(3000, 30),
    ]);
  });

  it("collapses same-second rows to the LAST row's value on the log-index tiebreak", () => {
    // Two ops in one block share a timestamp; log 10 is the later op and
    // its resulting state is the truth for that second — a string sort
    // ("_9" > "_10") would keep the wrong one.
    const rows = [
      ledgerRow({
        id: "42220_100_10",
        timestamp: "1000",
        blockNumber: "100",
        logIndex: 10,
        collAfter: wei(700),
        debtAfter: wei(70),
      }),
      ledgerRow({
        id: "42220_100_9",
        timestamp: "1000",
        blockNumber: "100",
        logIndex: 9,
        collAfter: wei(500),
        debtAfter: wei(50),
      }),
    ];
    const series = buildTroveChartSeries(rows, { debtSnapshotsComplete: true });
    expect(series.coll).toEqual([point(1000, 700)]);
    expect(series.debt).toEqual([point(1000, 70)]);
  });

  it("returns a null debt series when debt snapshots are incomplete — never a gapped or zero-coerced one", () => {
    const rows = [
      ledgerRow({ id: "42220_100_0", timestamp: "1000", logIndex: 0 }),
      ledgerRow({
        id: "42220_200_0",
        timestamp: "2000",
        blockNumber: "200",
        logIndex: 0,
        debtBefore: null,
        debtAfter: null,
      }),
    ];
    const series = buildTroveChartSeries(rows, {
      debtSnapshotsComplete: false,
    });
    expect(series.debt).toBeNull();
    // The collateral series still renders — coll snapshots stay non-null.
    expect(series.coll).toHaveLength(2);
  });

  it("converts icrAfterBps to percent and reports full coverage", () => {
    const rows = [
      ledgerRow({ id: "42220_100_0", timestamp: "1000", icrAfterBps: 11_710 }),
      ledgerRow({
        id: "42220_200_0",
        timestamp: "2000",
        blockNumber: "200",
        icrAfterBps: 16_500,
      }),
    ];
    const series = buildTroveChartSeries(rows, { debtSnapshotsComplete: true });
    expect(series.icr).toEqual([point(1000, 117.1), point(2000, 165)]);
    expect(series.icrCoverage).toBe("full");
  });

  it("reports partial coverage when only some rows carry price data", () => {
    const rows = [
      ledgerRow({ id: "42220_100_0", timestamp: "1000", icrAfterBps: null }),
      ledgerRow({
        id: "42220_200_0",
        timestamp: "2000",
        blockNumber: "200",
        icrAfterBps: 12_000,
      }),
    ];
    const series = buildTroveChartSeries(rows, { debtSnapshotsComplete: true });
    expect(series.icr).toEqual([point(2000, 120)]);
    expect(series.icrCoverage).toBe("partial");
  });

  it("reports no coverage — and plots nothing — when no row carries price data, including the -1 sentinel", () => {
    const rows = [
      ledgerRow({ id: "42220_100_0", timestamp: "1000", icrAfterBps: null }),
      ledgerRow({
        id: "42220_200_0",
        timestamp: "2000",
        blockNumber: "200",
        icrAfterBps: -1,
      }),
    ];
    const series = buildTroveChartSeries(rows, { debtSnapshotsComplete: true });
    expect(series.icr).toEqual([]);
    expect(series.icrCoverage).toBe("none");
  });

  it("marks redemption and liquidation rows only, deduped per second and kind", () => {
    const rows = [
      ledgerRow({ id: "42220_100_0", timestamp: "1000", operation: 0 }),
      ledgerRow({
        id: "42220_200_0",
        timestamp: "2000",
        blockNumber: "200",
        operation: 6,
      }),
      // A second redemption hit in the same second (split redemption) —
      // one marker, not two.
      ledgerRow({
        id: "42220_200_1",
        timestamp: "2000",
        blockNumber: "200",
        logIndex: 2,
        operation: 6,
      }),
      ledgerRow({
        id: "42220_300_0",
        timestamp: "3000",
        blockNumber: "300",
        operation: 5,
      }),
      ledgerRow({
        id: "42220_400_0",
        timestamp: "4000",
        blockNumber: "400",
        operation: 2,
      }),
    ];
    const series = buildTroveChartSeries(rows, { debtSnapshotsComplete: true });
    expect(series.markers).toEqual([
      { timestamp: 2000, kind: "redemption" },
      { timestamp: 3000, kind: "liquidation" },
    ]);
  });

  it("does not mutate the input row array", () => {
    const rows = [
      ledgerRow({ id: "42220_200_0", timestamp: "2000", blockNumber: "200" }),
      ledgerRow({ id: "42220_100_0", timestamp: "1000" }),
    ];
    buildTroveChartSeries(rows, { debtSnapshotsComplete: true });
    expect(rows[0]!.timestamp).toBe("2000");
  });
});

describe("stepSeriesInWindow", () => {
  const points = [point(1000, 10), point(5000, 50), point(9000, 90)];

  it("passes everything through with no cutoff", () => {
    expect(
      stepSeriesInWindow(points, null, 9000, { extendToNow: false }),
    ).toEqual(points);
  });

  it("carries the last pre-window vertex in, re-anchored AT the cutoff", () => {
    // Without the anchor the window would start mid-air: the value in
    // force at the window start comes from the 5000 vertex.
    expect(
      stepSeriesInWindow(points, 6000, 9000, { extendToNow: false }),
    ).toEqual([point(6000, 50), point(9000, 90)]);
  });

  it("needs no anchor when the first vertex is already inside the window", () => {
    expect(
      stepSeriesInWindow(points, 500, 9000, { extendToNow: false }),
    ).toEqual(points);
  });

  it("extends the final recorded value flat to now when asked", () => {
    expect(
      stepSeriesInWindow(points, null, 12_000, { extendToNow: true }),
    ).toEqual([...points, point(12_000, 90)]);
  });

  it("does not duplicate the terminal vertex when it already sits at now", () => {
    expect(
      stepSeriesInWindow(points, null, 9000, { extendToNow: true }),
    ).toEqual(points);
  });

  it("yields a flat anchored-plus-now line for a window with no events", () => {
    // A dormant trove viewed over 1d: nothing happened in the window, but
    // its recorded state still holds — anchor at the cutoff, extend to now.
    expect(
      stepSeriesInWindow(points, 10_000, 12_000, { extendToNow: true }),
    ).toEqual([point(10_000, 90), point(12_000, 90)]);
  });

  it("returns empty for an empty series", () => {
    expect(stepSeriesInWindow([], 1000, 2000, { extendToNow: true })).toEqual(
      [],
    );
  });
});

describe("markersInWindow", () => {
  const markers = [
    { timestamp: 1000, kind: "redemption" as const },
    { timestamp: 5000, kind: "liquidation" as const },
  ];

  it("passes everything through with no cutoff", () => {
    expect(markersInWindow(markers, null)).toEqual(markers);
  });

  it("drops markers before the cutoff — they have no value to anchor", () => {
    expect(markersInWindow(markers, 2000)).toEqual([
      { timestamp: 5000, kind: "liquidation" },
    ]);
  });
});
