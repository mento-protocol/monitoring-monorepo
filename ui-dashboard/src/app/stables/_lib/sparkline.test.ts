import { describe, expect, it } from "vitest";
import { sparklinePoints } from "./sparkline";

describe("sparklinePoints", () => {
  it("maps unchanged supply to the vertical midpoint", () => {
    const points = sparklinePoints([100, 100], 240, 40, 2);
    expect(points).toBe("2.0,20.0 238.0,20.0");
  });

  it("centers a flat series vertically", () => {
    const points = sparklinePoints([50, 50, 50], 240, 40, 2);
    expect(points).toBe("2.0,20.0 120.0,20.0 238.0,20.0");
  });

  it("uses a shared percent-change scale instead of per-card min-max", () => {
    const smallMove = sparklinePoints([100, 103], 240, 40, 2);
    const largeMove = sparklinePoints([100, 142], 240, 40, 2);

    expect(smallMove).toBe("2.0,20.0 238.0,11.3");
    expect(largeMove).toBe("2.0,20.0 238.0,2.6");
  });

  it("is invariant to absolute token supply scale", () => {
    const smallToken = sparklinePoints([100, 103], 240, 40, 2);
    const largeToken = sparklinePoints([1_000_000, 1_030_000], 240, 40, 2);

    expect(largeToken).toBe(smallToken);
  });

  it("preserves rank order across small and large percent moves", () => {
    const pointY = (points: string): number =>
      Number(points.split(" ")[1]?.split(",")[1]);

    const flat = pointY(sparklinePoints([100, 100.3], 240, 40, 2));
    const modest = pointY(sparklinePoints([100, 101.67], 240, 40, 2));
    const large = pointY(sparklinePoints([100, 110], 240, 40, 2));
    const severe = pointY(sparklinePoints([100, 142], 240, 40, 2));

    expect(flat).toBeGreaterThan(modest);
    expect(modest).toBeGreaterThan(large);
    expect(large).toBeGreaterThan(severe);
  });

  it("clips large negative moves to the chart edge", () => {
    const points = sparklinePoints([100, 0], 240, 40, 2);
    expect(points).toBe("2.0,20.0 238.0,38.0");
  });

  it("uses the first non-zero point as the percent baseline", () => {
    const points = sparklinePoints([0, 100, 110], 240, 40, 2);
    expect(points).toBe("2.0,38.0 120.0,20.0 238.0,7.4");
  });

  it("handles small fractional values without NaN", () => {
    const points = sparklinePoints([1e-9, 2e-9, 3e-9], 60, 20, 2);
    // Should parse cleanly with no "NaN" tokens.
    expect(points).not.toContain("NaN");
    expect(points.split(" ").length).toBe(3);
  });
});
