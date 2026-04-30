import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { computeRewardThresholds, renderRewardCell } from "../page";

function markup(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

describe("computeRewardThresholds", () => {
  it("returns null below the minimum sample size", () => {
    const rewards = Array.from({ length: 19 }, (_, i) => String(i + 1));
    expect(computeRewardThresholds(rewards)).toBeNull();
  });

  it("ignores null/empty/zero/non-numeric and uses positives only", () => {
    const rewards = [
      ...Array.from({ length: 30 }, (_, i) => String(i + 1)),
      null,
      undefined,
      "",
      "0",
      "abc",
    ];
    const thresholds = computeRewardThresholds(rewards);
    expect(thresholds).not.toBeNull();
    // 30 values 1..30 sorted; 1-based nearest-rank:
    // p95 = values[ceil(30*0.95)-1] = values[28] = 29
    // p90 = values[ceil(30*0.9)-1]  = values[26] = 27
    const [p95, p90] = thresholds!;
    expect(p95.tier.quantile).toBe(0.95);
    expect(p95.min).toBe(29);
    expect(p90.tier.quantile).toBe(0.9);
    expect(p90.min).toBe(27);
  });

  it("p95 tier fires at exactly the minimum sample size (regression)", () => {
    // floor(20*0.95) = 19 made p95 the max value, so strict '>' could
    // never fire. ceil(20*0.95)-1 = 18 keeps the cutoff one rank below
    // the max so a top-row outlier still triggers the tier.
    const rewards = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const thresholds = computeRewardThresholds(rewards)!;
    const [p95] = thresholds;
    expect(p95.min).toBe(19);
    const out = markup(renderRewardCell("20", thresholds));
    expect(out).toContain("text-amber-300");
    expect(out).toContain("Top 5%");
  });

  it("returns thresholds in highest-tier-first order", () => {
    const rewards = Array.from({ length: 100 }, (_, i) => String(i + 1));
    const thresholds = computeRewardThresholds(rewards)!;
    expect(thresholds[0].tier.quantile).toBeGreaterThan(
      thresholds[1].tier.quantile,
    );
  });
});

describe("renderRewardCell", () => {
  const thresholds = computeRewardThresholds(
    Array.from({ length: 100 }, (_, i) => String(i + 1)),
  )!;

  it("renders em-dash for null/undefined/empty", () => {
    expect(renderRewardCell(null, thresholds)).toBe("—");
    expect(renderRewardCell(undefined, thresholds)).toBe("—");
    expect(renderRewardCell("", thresholds)).toBe("—");
  });

  it("renders plain formatted USD when no thresholds available", () => {
    const out = markup(renderRewardCell("12.34", null));
    expect(out).not.toContain("text-amber");
    expect(out).toContain("$12.34");
  });

  it("highlights p95 outliers with the bright amber tier", () => {
    // p95 = 95 for [1..100]; strictly > 95 fires the tier
    const out = markup(renderRewardCell("99", thresholds));
    expect(out).toContain("text-amber-300");
    expect(out).toContain("font-semibold");
    expect(out).toContain("Top 5%");
  });

  it("highlights p90 outliers with the muted amber tier", () => {
    // p90 = 90; value 92 is above p90 but at-or-below p95 (95) so falls into p90
    const out = markup(renderRewardCell("92", thresholds));
    expect(out).toContain("text-amber-400");
    expect(out).toContain("Top 10%");
  });

  it("does not highlight values below all tiers", () => {
    const out = markup(renderRewardCell("50", thresholds));
    expect(out).not.toContain("text-amber");
  });

  it("does NOT highlight values that exactly tie the cutoff (regression)", () => {
    // With many tied values at the p95 cutoff, '>=' would mislabel them all
    // as outliers. Strict '>' suppresses ties and keeps the tier meaningful.
    const tiedRewards = Array.from({ length: 30 }, () => "7.63");
    const tiedThresholds = computeRewardThresholds(tiedRewards);
    // All 30 positive samples are identical, so no value is strictly greater
    // than the cutoff and nothing should be highlighted.
    const out = markup(renderRewardCell("7.63", tiedThresholds));
    expect(out).not.toContain("text-amber");
    expect(out).toContain("$7.63");
  });

  it("paints visually identical cells with the same tier (regression)", () => {
    // Real bug on pool 143-0xd0e9…ce081: four rebalances rendered as $9.85
    // (raw 9.8493/9.8496/9.8511/9.8518) but the raw-float comparison split
    // them across the p95 cutoff, leaving three amber and one plain. The
    // user can't see sub-cent differences, so two cells displaying "$9.85"
    // must always share a tier.
    const baseline = Array.from({ length: 25 }, (_, i) =>
      String(0.1 + i * 0.1),
    );
    const cluster = ["9.8493", "9.8496", "9.8511", "9.8518"];
    const thresholds = computeRewardThresholds([...baseline, ...cluster])!;
    const tiers = cluster.map((v) => {
      const out = markup(renderRewardCell(v, thresholds));
      if (out.includes("text-amber-300")) return "p95";
      if (out.includes("text-amber-400")) return "p90";
      return "plain";
    });
    expect(new Set(tiers).size).toBe(1);
    // And every cell formats identically — guards against future format
    // changes silently splitting the cluster again.
    cluster.forEach((v) => {
      expect(markup(renderRewardCell(v, thresholds))).toContain("$9.85");
    });
  });
});
