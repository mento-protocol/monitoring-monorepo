import { describe, expect, it } from "vitest";
import { decimateSeries } from "../oracle-decimation";

type Row = { id: string; ts: number; red: boolean };

const row = (ts: number, red = false): Row => ({ id: `r-${ts}`, ts, red });

const opts = (
  over: Partial<Parameters<typeof decimateSeries<Row>>[1]> = {},
) => ({
  visibleRange: null,
  cap: 100,
  getTimestamp: (r: Row) => r.ts,
  isAnomalous: (r: Row) => r.red,
  ...over,
});

describe("decimateSeries", () => {
  it("is the identity when the series fits under the cap", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    const out = decimateSeries(rows, opts({ cap: 100 }));
    expect(out).toEqual(rows);
  });

  it("caps an oversized series to roughly the budget", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => row(i));
    const out = decimateSeries(rows, opts({ cap: 2000 }));
    // Strided down to the cap (a touch of slack for endpoints/rounding).
    expect(out.length).toBeLessThanOrEqual(2010);
    expect(out.length).toBeGreaterThan(1000);
  });

  it("never drops an anomalous (red) point, even far past the cap", () => {
    const rows: Row[] = [];
    const redIds = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      const isRed = i % 500 === 0; // 20 red points
      const r = row(i, isRed);
      if (isRed) redIds.add(r.id);
      rows.push(r);
    }
    const out = decimateSeries(rows, opts({ cap: 2000 }));
    const keptIds = new Set(out.map((r) => r.id));
    for (const id of redIds) expect(keptIds.has(id)).toBe(true);
  });

  it("keeps all red points even when reds alone exceed the cap", () => {
    // 300 reds, cap 100 — anomalies always win over the soft cap.
    const rows = Array.from({ length: 300 }, (_, i) => row(i, true));
    const out = decimateSeries(rows, opts({ cap: 100 }));
    expect(out).toHaveLength(300);
  });

  it("keeps the first and last in-window points (line endpoints)", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(i));
    const out = decimateSeries(rows, opts({ cap: 500 }));
    expect(out[0]!.id).toBe("r-0");
    expect(out[out.length - 1]!.id).toBe("r-4999");
  });

  it("scopes to the visible window (+ one-span margin) and yields exact points there", () => {
    // 10k rows at ts 0..9999; zoom into [5000, 5100] (span 100). With a
    // one-span margin the slice is [4900, 5200] = ~301 rows < cap → exact.
    const rows = Array.from({ length: 10_000 }, (_, i) => row(i));
    const out = decimateSeries(
      rows,
      opts({ visibleRange: [5000, 5100], cap: 2000 }),
    );
    expect(out.every((r) => r.ts >= 4900 && r.ts <= 5200)).toBe(true);
    // Exact (no decimation) within the windowed slice.
    expect(out).toHaveLength(301);
  });

  it("falls back to the full series when the window holds no points", () => {
    const rows = [row(0), row(10_000)];
    const out = decimateSeries(
      rows,
      opts({ visibleRange: [4000, 4001], cap: 100 }),
    );
    expect(out).toHaveLength(2);
  });

  it("returns the empty input unchanged", () => {
    expect(decimateSeries<Row>([], opts())).toEqual([]);
  });

  it("emits in ascending order", () => {
    const rows = Array.from({ length: 3000 }, (_, i) => row(i, i % 7 === 0));
    const out = decimateSeries(rows, opts({ cap: 500 }));
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]!.ts).toBeGreaterThan(out[i - 1]!.ts);
    }
  });
});
