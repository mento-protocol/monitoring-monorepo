import { describe, expect, it } from "vitest";
import { railGradient } from "../opengraph-image";

/** Percent positions on the fixed ±60 bps rail, to 2dp as the card emits them. */
const at = (bps: number) => 50 + (bps / 60) * 50;

describe("railGradient", () => {
  it("puts every colour boundary on the threshold RailScale labels", () => {
    // EUROP's live policy. The card labels "critical −50" and "warn −25", so
    // the red→amber and amber→green edges must land on exactly those points —
    // the page's hardcoded 10%/30%/70% stops are really ∓48/∓24 and would
    // print each label against a band starting somewhere else.
    const gradient = railGradient({
      downsideWarn: 25,
      downsideCritical: 50,
      premiumWarn: 25,
    });

    expect(gradient).toContain(`${at(-50)}%`);
    expect(gradient).toContain(`${at(-25)}%`);
    expect(gradient).toContain(`${at(25)}%`);
    expect(gradient).not.toContain("10%");
    expect(gradient).not.toContain("30%");
    expect(gradient).not.toContain("70%");
  });

  it("tracks a peg on different policy instead of asserting EUROP's bands", () => {
    const gradient = railGradient({
      downsideWarn: 40,
      downsideCritical: 55,
      premiumWarn: 10,
    });

    expect(gradient).toContain(`${at(-55)}%`);
    expect(gradient).toContain(`${at(-40)}%`);
    expect(gradient).toContain(`${at(10)}%`);
  });

  it("clamps a threshold wider than the rail so its zone runs off the end", () => {
    // A 90 bps critical sits outside the ±60 window. The red band should fill
    // to the rail's edge rather than emit a negative stop Satori would drop.
    const gradient = railGradient({
      downsideWarn: 70,
      downsideCritical: 90,
      premiumWarn: 25,
    });

    expect(gradient).not.toMatch(/-\d/);
    expect(gradient).toContain("0%");
  });
});
