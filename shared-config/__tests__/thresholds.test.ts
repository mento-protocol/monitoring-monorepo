import { describe, it, expect } from "vitest";
import {
  DEVIATION_CRITICAL_RATIO,
  DEVIATION_TOLERANCE_RATIO,
  POOL_DEPLETION_CRITICAL_SHARE,
  POOL_DEPLETION_PAGE_SHARE,
} from "../src/thresholds";

// These constants are referenced from indexer handlers, the metrics-bridge
// probe, the dashboard, AND mirrored as HCL literals in
// `alerts/rules/rules-fpmms.tf`. Any value change is a coordinated edit
// across packages — the test exists to make that intent explicit so a casual
// edit here trips CI.
describe("deviation thresholds", () => {
  it("DEVIATION_TOLERANCE_RATIO is 1.01 (1% over rebalance threshold)", () => {
    expect(DEVIATION_TOLERANCE_RATIO).toBe(1.01);
  });

  it("DEVIATION_CRITICAL_RATIO is 1.05 (5% over rebalance threshold)", () => {
    expect(DEVIATION_CRITICAL_RATIO).toBe(1.05);
  });

  it("tolerance is strictly below critical (sanity)", () => {
    expect(DEVIATION_TOLERANCE_RATIO).toBeLessThan(DEVIATION_CRITICAL_RATIO);
  });
});

describe("pool depletion shares", () => {
  it("POOL_DEPLETION_CRITICAL_SHARE is 0.2 (20% of reserves on the thin side)", () => {
    expect(POOL_DEPLETION_CRITICAL_SHARE).toBe(0.2);
  });

  it("POOL_DEPLETION_PAGE_SHARE is 0.1 (10% of reserves on the thin side)", () => {
    expect(POOL_DEPLETION_PAGE_SHARE).toBe(0.1);
  });

  // The two Grafana rules partition [0, critical) at the page share: the page
  // rule's evaluator caps at it, the critical rule's PromQL floors at it. A
  // page share at or above the critical share would collapse that partition
  // into an overlap (both rules firing) or a gap (neither).
  it("page share is strictly below critical share", () => {
    expect(POOL_DEPLETION_PAGE_SHARE).toBeLessThan(
      POOL_DEPLETION_CRITICAL_SHARE,
    );
  });

  it("both shares are fractions of a pool side, not percentages", () => {
    for (const share of [
      POOL_DEPLETION_PAGE_SHARE,
      POOL_DEPLETION_CRITICAL_SHARE,
    ]) {
      expect(share).toBeGreaterThan(0);
      // A side share can never exceed 0.5 and still be the smaller side.
      expect(share).toBeLessThan(0.5);
    }
  });
});
