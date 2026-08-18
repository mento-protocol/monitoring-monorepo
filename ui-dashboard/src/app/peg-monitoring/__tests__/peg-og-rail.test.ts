import { describe, expect, it } from "vitest";
import { railGradient, railTicks } from "../_lib/peg-og-layout";

/** Percent position of a signed bps value on the fixed ±60 bps rail.
 *  Full float precision, matching what the gradient string carries. */
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

describe("railTicks", () => {
  it("labels every threshold when they sit far enough apart", () => {
    const ticks = railTicks({
      downsideWarn: 25,
      downsideCritical: 50,
      premiumWarn: 25,
    });

    expect(ticks.map((tick) => tick.label)).toEqual([
      "critical −50",
      "warn −25",
      "TARGET",
      "warn +25",
    ]);
  });

  it("drops the less severe of two ticks too close to label separately", () => {
    // 20 and 25 bps sit ~4% apart on the rail; their ~140px centred labels
    // would print as one unreadable run. Worst-first ordering means the
    // critical tick survives and the warn tick is the one dropped.
    const labels = railTicks({
      downsideWarn: 20,
      downsideCritical: 25,
      premiumWarn: 25,
    }).map((tick) => tick.label);

    expect(labels).toContain("critical −25");
    expect(labels).not.toContain("warn −20");
  });

  it("keeps the target tick and returns ticks in rail order", () => {
    const ticks = railTicks({
      downsideWarn: 20,
      downsideCritical: 25,
      premiumWarn: 25,
    });
    const positions = ticks.map((tick) => tick.at);

    expect(ticks.map((tick) => tick.label)).toContain("TARGET");
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("drops a threshold outside the rail rather than clamping it", () => {
    const ticks = railTicks({
      downsideWarn: 25,
      downsideCritical: 90,
      premiumWarn: 25,
    });

    expect(ticks.map((tick) => tick.label)).not.toContain("critical −90");
    expect(ticks.every((tick) => tick.at >= 0 && tick.at <= 100)).toBe(true);
  });
});
