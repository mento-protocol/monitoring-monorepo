import { describe, it, expect } from "vitest";
import {
  DEVIATION_CRITICAL_RATIO,
  DEVIATION_TOLERANCE_RATIO,
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
