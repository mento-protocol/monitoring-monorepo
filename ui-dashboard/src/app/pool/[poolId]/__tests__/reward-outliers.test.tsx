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
    // 30 values 1..30 sorted; nearest-rank floor(30*0.95)=28 → 29; floor(30*0.9)=27 → 28
    const [p95, p90] = thresholds!;
    expect(p95.tier.quantile).toBe(0.95);
    expect(p95.min).toBe(29);
    expect(p90.tier.quantile).toBe(0.9);
    expect(p90.min).toBe(28);
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
});
