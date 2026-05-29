/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { lookAheadTarget, readXRange } from "../oracle-chart";

// Plotly emits X range as ISO-ish strings; convert to unix seconds.
const sec = (iso: string) => new Date(iso).getTime() / 1000;

describe("readXRange", () => {
  it("parses the individual-key form (drag pan / wheel-X zoom)", () => {
    const out = readXRange({
      "xaxis.range[0]": "2026-05-01T00:00:00Z",
      "xaxis.range[1]": "2026-05-08T00:00:00Z",
    });
    expect(out).not.toBeNull();
    expect(out![0]).toBe(sec("2026-05-01T00:00:00Z"));
    expect(out![1]).toBe(sec("2026-05-08T00:00:00Z"));
  });

  it("parses the array form (rangeslider drag)", () => {
    const out = readXRange({
      "xaxis.range": ["2026-05-01T00:00:00Z", "2026-05-08T00:00:00Z"],
    });
    expect(out).not.toBeNull();
    expect(out![1]).toBeGreaterThan(out![0]);
  });

  it("returns null for a Y-only relayout (the anti-double-fire guard)", () => {
    // The wheel handler's Y-zoom emits only yaxis.range — it must NOT trigger
    // a history fetch or a decimation re-scope.
    expect(readXRange({ "yaxis.range": [0.99, 1.01] })).toBeNull();
    expect(
      readXRange({ "yaxis.range[0]": 0.99, "yaxis.range[1]": 1.01 }),
    ).toBeNull();
  });

  it('returns null for an autorange reset ("All" / double-click)', () => {
    expect(readXRange({ "xaxis.autorange": true })).toBeNull();
  });

  it("returns null for an empty / unrelated relayout", () => {
    expect(readXRange({})).toBeNull();
    expect(readXRange({ dragmode: "pan" })).toBeNull();
  });

  it("returns null for a degenerate (zero/negative-width) range", () => {
    expect(
      readXRange({
        "xaxis.range[0]": "2026-05-08T00:00:00Z",
        "xaxis.range[1]": "2026-05-01T00:00:00Z",
      }),
    ).toBeNull();
  });
});

describe("lookAheadTarget", () => {
  const DAY = 86_400;
  const oldest = 1_000_000;

  it("fires when the left edge is within the fraction of a span of the oldest", () => {
    // span = 7d; left edge 0.1 span past oldest → within the 0.2 threshold.
    const left = oldest - 0.1 * 7 * DAY;
    const right = left + 7 * DAY;
    const target = lookAheadTarget([left, right], oldest, 0.2);
    expect(target).not.toBeNull();
    // Loads one fraction-span past the left edge.
    expect(target).toBeCloseTo(left - 0.2 * 7 * DAY, 3);
  });

  it("does not fire when the left edge has comfortable headroom", () => {
    // left edge a full span newer than oldest → far from the boundary.
    const right = oldest + 14 * DAY;
    const left = oldest + 7 * DAY;
    expect(lookAheadTarget([left, right], oldest, 0.2)).toBeNull();
  });

  it("fires when the left edge is already past the oldest loaded point", () => {
    const left = oldest - 3 * DAY;
    const right = left + 7 * DAY;
    expect(lookAheadTarget([left, right], oldest, 0.2)).not.toBeNull();
  });

  it("returns null for a zero/negative span", () => {
    expect(lookAheadTarget([oldest, oldest], oldest, 0.2)).toBeNull();
  });
});
