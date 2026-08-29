// Series derivation for the trove history chart
// (docs/PLAN-trove-history-page.md, "UI design → Chart"): step vertices from
// ledger `collAfter`/`debtAfter`/`icrAfterBps`, the range window with its
// step-anchor carry, and the protocol-event markers. Pure functions only —
// trace/layout assembly lives in `trove-balance-chart.tsx`, and every input
// row comes from the one bounded `useTroveLedger` read (invariant 5: charts
// read the full history query, never a paginated slice).

import { parseWei } from "@/lib/format";
import { sortedCopy } from "@/lib/immutable-sort";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import {
  compareTroveLedgerRowsDesc,
  type CdpTroveLedgerEventRow,
} from "./ledger";

// Operation ordinals this module needs by name. Mirrors `OP` in
// indexer-envio/src/handlers/liquity/operations.ts (cross-package imports
// are off-limits; renumbering must update both).
const OP_LIQUIDATE = 5;
const OP_REDEEM_COLLATERAL = 6;

/** Route-local pill set (1d/7d/30d/All per the approved canvas). The shared
 *  `RangeKey` union has no 1d member and its `filterSeriesByRange` drops the
 *  pre-window step anchor, so this chart carries its own keys + window. */
export type TroveChartRangeKey = "1d" | "7d" | "30d" | "all";

export const TROVE_CHART_RANGES: ReadonlyArray<{
  key: TroveChartRangeKey;
  label: string;
}> = [
  { key: "1d", label: "1d" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

const RANGE_DAYS: Record<TroveChartRangeKey, number | null> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  all: null,
};

/** Window start in epoch seconds; `null` means "all history" (no cutoff). */
export function troveChartRangeCutoff(
  range: TroveChartRangeKey,
  nowSeconds: number,
): number | null {
  const days = RANGE_DAYS[range];
  return days === null ? null : nowSeconds - days * SECONDS_PER_DAY;
}

export type TroveChartPoint = {
  timestamp: number;
  value: number;
};

export type TroveChartMarker = {
  timestamp: number;
  kind: "redemption" | "liquidation";
};

export type TroveChartSeries = {
  /** Recorded collateral after each event (USDm). Always derivable —
   *  collateral snapshots are non-null on every ledger row. */
  coll: TroveChartPoint[];
  /** Recorded debt after each event (debt-token units). `null` when any
   *  row's debt snapshot is null (batch-op rows) — the panel then shows the
   *  explicit "batch data unavailable" notice, never a gapped or
   *  zero-coerced series. */
  debt: TroveChartPoint[] | null;
  /** Indexed ICR (percent) at events that carry price data; can be empty.
   *  Same-second observations remain distinct marker points. */
  icr: TroveChartPoint[];
  /** Drives the ICR panel + its disclosure: `none` drops the panel and says
   *  so (historical-replay rows persist no price by design), `partial`
   *  keeps the panel with a "only where price data exists" note. */
  icrCoverage: "full" | "partial" | "none";
  /** Protocol events that hit the trove (redemptions, liquidation) —
   *  rendered as vertical marker lines, deduped per second and kind. */
  markers: TroveChartMarker[];
};

/** One vertex per second, keeping the LAST row's value: same-second rows
 *  (one block, or two blocks in a second) collapse to the final state of
 *  that second, so the step never draws a zero-width zig-zag and hover
 *  reports one truthful value per x. */
function collapseSameSecond(points: TroveChartPoint[]): TroveChartPoint[] {
  const out: TroveChartPoint[] = [];
  for (const point of points) {
    const previous = out[out.length - 1];
    if (previous != null && previous.timestamp === point.timestamp) {
      out[out.length - 1] = point;
    } else {
      out.push(point);
    }
  }
  return out;
}

function buildMarkers(
  ascending: readonly CdpTroveLedgerEventRow[],
): TroveChartMarker[] {
  const out: TroveChartMarker[] = [];
  const seen = new Set<string>();
  for (const row of ascending) {
    const kind =
      row.operation === OP_REDEEM_COLLATERAL
        ? ("redemption" as const)
        : row.operation === OP_LIQUIDATE
          ? ("liquidation" as const)
          : null;
    if (kind == null) continue;
    const key = `${kind}-${row.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ timestamp: Number(row.timestamp), kind });
  }
  return out;
}

export function buildTroveChartSeries(
  rows: readonly CdpTroveLedgerEventRow[],
  { debtSnapshotsComplete }: { debtSnapshotsComplete: boolean },
): TroveChartSeries {
  // Re-assert chronological order on the numeric triple via `sortedCopy` —
  // same invariant-independence rationale as `sortTroveLedgerRowsDesc`; the
  // string id never participates.
  const ascending = sortedCopy(rows, (a, b) =>
    compareTroveLedgerRowsDesc(b, a),
  );
  const coll = collapseSameSecond(
    ascending.map((row) => ({
      timestamp: Number(row.timestamp),
      value: parseWei(row.collAfter),
    })),
  );
  // `debtSnapshotsComplete` guarantees every `debtAfter` is non-null; the
  // fallback only satisfies the type — it can never zero-coerce a real row.
  const debt = debtSnapshotsComplete
    ? collapseSameSecond(
        ascending.map((row) => ({
          timestamp: Number(row.timestamp),
          value: parseWei(row.debtAfter ?? "0"),
        })),
      )
    : null;
  // Null means "no price at this row" (historical replay); a defensive
  // negative check keeps the -1 unknown-sentinel convention from ever
  // plotting should it leak into ledger rows.
  const icrRows = ascending.filter(
    (row) => row.icrAfterBps != null && row.icrAfterBps >= 0,
  );
  // ICR renders as independent observations, so same-second rows stay
  // distinct even though they share an x-coordinate. Only balance steps
  // collapse to the second's final state.
  const icr = icrRows.map((row) => ({
    timestamp: Number(row.timestamp),
    value: (row.icrAfterBps ?? 0) / 100,
  }));
  const icrCoverage =
    icrRows.length === 0
      ? ("none" as const)
      : icrRows.length === ascending.length
        ? ("full" as const)
        : ("partial" as const);
  return { coll, debt, icr, icrCoverage, markers: buildMarkers(ascending) };
}

/** Window a step series for the active range. Two step-specific rules a
 *  plain `timestamp >= cutoff` filter gets wrong:
 *  - the last pre-window vertex is carried in, re-anchored AT the cutoff,
 *    so the panel starts with the value that was in force — not mid-air;
 *  - with `extendToNow`, the final recorded value extends flat to `now`
 *    (recorded balances hold between events; a closed trove honestly flat-
 *    lines at zero). ICR passes false — extending a stale price-derived
 *    ratio would fabricate a current reading. */
export function stepSeriesInWindow(
  points: readonly TroveChartPoint[],
  cutoff: number | null,
  nowSeconds: number,
  { extendToNow }: { extendToNow: boolean },
): TroveChartPoint[] {
  const windowed: TroveChartPoint[] = [];
  if (cutoff == null) {
    windowed.push(...points);
  } else {
    let anchor: TroveChartPoint | null = null;
    for (const point of points) {
      if (point.timestamp < cutoff) {
        anchor = point;
      } else {
        windowed.push(point);
      }
    }
    if (anchor != null) {
      windowed.unshift({ timestamp: cutoff, value: anchor.value });
    }
  }
  const lastPoint = windowed[windowed.length - 1];
  if (extendToNow && lastPoint != null && lastPoint.timestamp < nowSeconds) {
    windowed.push({ timestamp: nowSeconds, value: lastPoint.value });
  }
  return windowed;
}

/** Markers carry no value to anchor, so the window is a plain filter. */
export function markersInWindow(
  markers: readonly TroveChartMarker[],
  cutoff: number | null,
): TroveChartMarker[] {
  if (cutoff == null) return [...markers];
  return markers.filter((marker) => marker.timestamp >= cutoff);
}
