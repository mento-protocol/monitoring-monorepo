import { describe, it, expect } from "vitest";
import { toHumanUnits } from "../src/units";

// `toHumanUnits` is the single source of truth for raw uint256 → human-units
// conversion across the metrics-bridge alert probe and the ui-dashboard
// rebalance tooltip. The two surfaces must agree byte-for-byte; the test
// pins both invariants (precision past 2^53 + small-value fidelity) so a
// casual edit here trips CI before either consumer drifts.
describe("toHumanUnits", () => {
  it("returns Number(raw) when decimals <= 0", () => {
    expect(toHumanUnits(0n, 0)).toBe(0);
    expect(toHumanUnits(123n, 0)).toBe(123);
    // Negative decimals shouldn't crash — defensive for misconfigured ABI reads.
    expect(toHumanUnits(45n, -1)).toBe(45);
  });

  it("converts whole-token values for 18-decimal tokens", () => {
    expect(toHumanUnits(10n ** 18n, 18)).toBe(1);
    expect(toHumanUnits(2n * 10n ** 18n, 18)).toBe(2);
  });

  it("preserves fractional precision up to 6 digits", () => {
    // 0.123456 with 18 decimals.
    expect(toHumanUnits(123456n * 10n ** 12n, 18)).toBeCloseTo(0.123456, 6);
  });

  it("does not lose precision past 2^53 — large supply, 18 decimals", () => {
    // 10M whole tokens, 18 decimals — naive Number(raw) / 10^18 truncates.
    const raw = 10_000_000n * 10n ** 18n;
    expect(toHumanUnits(raw, 18)).toBe(10_000_000);
  });

  it("handles 6-decimal tokens (USDC-shape)", () => {
    expect(toHumanUnits(12_500_000_000n, 6)).toBe(12_500);
    expect(toHumanUnits(0n, 6)).toBe(0);
  });

  it("returns 0 for raw=0 regardless of decimals", () => {
    expect(toHumanUnits(0n, 18)).toBe(0);
    expect(toHumanUnits(0n, 6)).toBe(0);
  });
});
