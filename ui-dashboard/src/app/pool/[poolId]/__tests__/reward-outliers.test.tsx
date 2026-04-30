import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computeRewardThresholds,
  renderRewardCell,
  toDisplayPrecision,
} from "../page";
import { formatUSD } from "@/lib/format";

function markup(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

// Median-absolute-deviation reference helper — identical to the one used
// inside computeRewardThresholds, but inlined here so tests can exercise
// the math directly without re-exporting an internal.
function expectedCutoffs(values: number[]): { strong: number; mild: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const dev = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const dmid = Math.floor(dev.length / 2);
  const mad =
    dev.length % 2 === 0 ? (dev[dmid - 1] + dev[dmid]) / 2 : dev[dmid];
  return { strong: med + 5 * mad, mild: med + 3 * mad };
}

describe("computeRewardThresholds", () => {
  it("returns null below the minimum sample size (N<5)", () => {
    expect(computeRewardThresholds(["1", "2", "3", "4"])).toBeNull();
  });

  it("returns thresholds at exactly the minimum sample size", () => {
    const thresholds = computeRewardThresholds(["1", "2", "3", "4", "5"]);
    expect(thresholds).not.toBeNull();
  });

  it("returns null when MAD is zero (every sample identical)", () => {
    // Half-or-more identical samples force MAD to 0; without a meaningful
    // spread there's no defensible cutoff, so we skip highlighting rather
    // than tier on noise.
    const tied = Array.from({ length: 30 }, () => "7.63");
    expect(computeRewardThresholds(tied)).toBeNull();
  });

  it("ignores null/empty/zero/non-numeric and uses positives only", () => {
    const rewards = [
      "1",
      "2",
      "3",
      "4",
      "10",
      null,
      undefined,
      "",
      "0",
      "-5",
      "abc",
    ];
    const thresholds = computeRewardThresholds(rewards);
    expect(thresholds).not.toBeNull();
    // Verify that the negative/zero/non-numeric rows didn't change the
    // computed cutoffs (they should match the cutoff for positives only).
    const expected = expectedCutoffs([1, 2, 3, 4, 10]);
    expect(thresholds![0].cutoff).toBeCloseTo(expected.strong, 6);
    expect(thresholds![1].cutoff).toBeCloseTo(expected.mild, 6);
  });

  it("computes cutoff = median + k·MAD for the configured tiers", () => {
    // 1..30 → median = 15.5, MAD = 7.5 → mild = 38, strong = 53.
    const thresholds = computeRewardThresholds(
      Array.from({ length: 30 }, (_, i) => String(i + 1)),
    )!;
    const [strong, mild] = thresholds;
    expect(strong.tier.kMad).toBe(5);
    expect(strong.cutoff).toBeCloseTo(53, 6);
    expect(mild.tier.kMad).toBe(3);
    expect(mild.cutoff).toBeCloseTo(38, 6);
  });

  it("returns thresholds in strongest-tier-first order", () => {
    const thresholds = computeRewardThresholds(
      Array.from({ length: 100 }, (_, i) => String(i + 1)),
    )!;
    expect(thresholds[0].tier.kMad).toBeGreaterThan(thresholds[1].tier.kMad);
    expect(thresholds[0].cutoff).toBeGreaterThan(thresholds[1].cutoff);
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

  it("highlights strong outliers with the bright amber tier", () => {
    // 1..100 → median=50.5, MAD=25 → strong cutoff = 50.5 + 5·25 = 175.5
    const out = markup(renderRewardCell("200", thresholds));
    expect(out).toContain("text-amber-300");
    expect(out).toContain("font-semibold");
    expect(out).toContain("Strong reward outlier");
  });

  it("highlights mild outliers with the muted amber tier", () => {
    // mild cutoff = 50.5 + 3·25 = 125.5; strong = 175.5; 150 is between
    const out = markup(renderRewardCell("150", thresholds));
    expect(out).toContain("text-amber-400");
    expect(out).not.toContain("font-semibold");
    expect(out).toContain("Reward outlier");
  });

  it("does not highlight values below all tiers", () => {
    const out = markup(renderRewardCell("80", thresholds));
    expect(out).not.toContain("text-amber");
  });

  it("highlights every member of a tail cluster (regression: pool 143-0xd0e9…ce081)", () => {
    // Real bug from the percentile-based predecessor: on a bimodal pool
    // with ~30 small rewards and a tight cluster at $9.85, the percentile
    // cutoff fell inside the cluster and strict `>` suppressed every
    // member. MAD's cutoff sits well above the bulk so the cluster fires
    // cleanly as one tier.
    const baseline = Array.from({ length: 30 }, (_, i) =>
      String(0.01 + i * 0.01),
    );
    const cluster = ["9.8493", "9.8496", "9.8511", "9.8518"];
    const ts = computeRewardThresholds([...baseline, ...cluster])!;
    const tiers = cluster.map((v) => {
      const out = markup(renderRewardCell(v, ts));
      if (out.includes("text-amber-300")) return "strong";
      if (out.includes("text-amber-400")) return "mild";
      return "plain";
    });
    expect(new Set(tiers).size).toBe(1);
    expect(tiers[0]).not.toBe("plain");
  });

  it("paints visually identical cells with the same tier (regression)", () => {
    // Cells that render to the same string must always share a tier —
    // sub-cent raw differences cannot split them. toDisplayPrecision rounds
    // before the comparison so this invariant holds even if the cutoff
    // happens to land between two display-equal raw values.
    const baseline = Array.from({ length: 30 }, (_, i) =>
      String(0.01 + i * 0.01),
    );
    const cluster = ["9.8493", "9.8496", "9.8511", "9.8518"];
    const ts = computeRewardThresholds([...baseline, ...cluster])!;
    cluster.forEach((v) => {
      expect(markup(renderRewardCell(v, ts))).toContain("$9.85");
    });
  });

  it("rounds in lockstep with formatUSD across $X50 boundaries (regression)", () => {
    // formatUSD's `.toFixed(1)` rounds half-to-even-ish per IEEE-754, while
    // a naive `Math.round(value / 100) * 100` rounds half-away-from-zero.
    // toDisplayPrecision parses formatUSD's own output to keep the two in
    // sync, so two values rendering as the same string always round to the
    // same threshold value.
    const pairs: [number, number][] = [
      [9.8493, 9.8518],
      [1051, 1149],
      [1451, 1549],
      [1551, 1649],
      [1951, 2049],
      [1_234_400, 1_234_499],
    ];
    for (const [a, b] of pairs) {
      expect(formatUSD(a)).toBe(formatUSD(b));
      expect(toDisplayPrecision(a)).toBe(toDisplayPrecision(b));
    }
  });
});
