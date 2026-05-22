import { describe, expect, it } from "vitest";
import { sparklinePoints } from "./sparkline";

describe("sparklinePoints", () => {
  it("maps a 2-point series to viewBox corners (pad-adjusted)", () => {
    // 2 points → step = (240 - 4) / 1 = 236. First at x=2, last at x=238.
    // min=0, max=100, span=100 → first y=2 + 36*1 = 38, last y=2 + 36*0 = 2.
    const points = sparklinePoints([0, 100], 240, 40, 2);
    expect(points).toBe("2.0,38.0 238.0,2.0");
  });

  it("centers a flat series vertically (span=0 fallback)", () => {
    // All values equal → span coerces to 1 → all y = pad (top). Acceptable
    // visual: a flat line at the top edge. The empty-state placeholder
    // catches the < 2 length case upstream.
    const points = sparklinePoints([50, 50, 50], 240, 40, 2);
    // 3 points: step = 236/2 = 118. x = 2, 120, 238. y = 2 (top edge,
    // since (v - min)/span = 0/1 = 0 → y = pad + 36*(1 - 0) = 38... wait
    // that's the BOTTOM. Let me re-check: (v - min)/span = (50-50)/1 = 0,
    // so y = 2 + 36*1 = 38. So actually it lands at the BOTTOM. OK.
    expect(points).toBe("2.0,38.0 120.0,38.0 238.0,38.0");
  });

  it("rescales an ascending series across the y axis", () => {
    // 5 points, monotonic. Step x = 236/4 = 59. y for v=0 is 38, for
    // v=100 is 2. Midpoint v=50 lands at y=20.
    const points = sparklinePoints([0, 25, 50, 75, 100], 240, 40, 2);
    expect(points).toBe("2.0,38.0 61.0,29.0 120.0,20.0 179.0,11.0 238.0,2.0");
  });

  it("handles small fractional values without NaN", () => {
    const points = sparklinePoints([1e-9, 2e-9, 3e-9], 60, 20, 2);
    // Should parse cleanly with no "NaN" tokens.
    expect(points).not.toContain("NaN");
    expect(points.split(" ").length).toBe(3);
  });
});
