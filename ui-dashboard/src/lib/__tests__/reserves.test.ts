import { describe, it, expect } from "vitest";
import { computeReservePcts, computeThresholdLines } from "../reserves";

// computeReservePcts

describe("computeReservePcts", () => {
  describe("USD-normalized path (oracle available)", () => {
    it("returns 50/50 for a balanced parity pool", () => {
      const { pct0, pct1 } = computeReservePcts(1000, 1000, 1000, 1000);
      expect(pct0).toBeCloseTo(50);
      expect(pct1).toBeCloseTo(50);
    });

    it("returns correct split for a 60/40 USD position", () => {
      const { pct0, pct1 } = computeReservePcts(1000, 1000, 24000, 16000);
      expect(pct0).toBeCloseTo(60);
      expect(pct1).toBeCloseTo(40);
    });

    it("corrects a non-parity pair (KESm/USDm at equilibrium)", () => {
      // 1 KES ≈ 0.0077 USD → at oracle balance: 130 KES ≈ 1 USD
      // raw count: 1300 / (1300 + 10) = 99.2% — very misleading
      // USD-normalized: 10 / (10 + 10) = 50%
      const kesAmount = 1300;
      const usdAmount = 10;
      const kesUsdValue = 10; // 1300 KES × 0.0077 = $10
      const usdUsdValue = 10;
      const { pct0, pct1 } = computeReservePcts(
        kesAmount,
        usdAmount,
        kesUsdValue,
        usdUsdValue,
      );
      expect(pct0).toBeCloseTo(50);
      expect(pct1).toBeCloseTo(50);
    });

    it("handles a skewed non-parity pair correctly in USD terms", () => {
      // KESm at 75% USD value, USDm at 25%
      const { pct0, pct1 } = computeReservePcts(9750, 25, 75, 25);
      expect(pct0).toBeCloseTo(75);
      expect(pct1).toBeCloseTo(25);
    });

    it("returns 100/0 when one side is fully depleted (usd0=0)", () => {
      const { pct0, pct1 } = computeReservePcts(0, 1000, 0, 1000);
      expect(pct0).toBe(0);
      expect(pct1).toBe(100);
    });

    it("returns 0/100 when the other side is fully depleted (usd1=0)", () => {
      const { pct0, pct1 } = computeReservePcts(1000, 0, 1000, 0);
      expect(pct0).toBe(100);
      expect(pct1).toBe(0);
    });
  });

  describe("raw count fallback (no oracle)", () => {
    it("uses raw token count when usd values are null", () => {
      // 750 of token0, 250 of token1 → 75%/25% by count
      const { pct0, pct1 } = computeReservePcts(750, 250, null, null);
      expect(pct0).toBeCloseTo(75);
      expect(pct1).toBeCloseTo(25);
    });

    it("uses raw count when only usd0 is null", () => {
      const { pct0, pct1 } = computeReservePcts(600, 400, null, 400);
      expect(pct0).toBeCloseTo(60);
      expect(pct1).toBeCloseTo(40);
    });
  });

  describe("empty pool edge cases", () => {
    it("returns 0/100 when both reserves are zero (not 50/50)", () => {
      // Critical: an empty pool must NOT show as half-full
      const { pct0, pct1 } = computeReservePcts(0, 0, 0, 0);
      expect(pct0).toBe(0);
      expect(pct1).toBe(100);
    });

    it("returns 0/100 when raw totals are also zero and no oracle", () => {
      const { pct0, pct1 } = computeReservePcts(0, 0, null, null);
      expect(pct0).toBe(0);
      expect(pct1).toBe(100);
    });

    it("pct0 + pct1 always equals 100", () => {
      const cases: [
        number | null,
        number | null,
        number | null,
        number | null,
      ][] = [
        [1000, 1000, 1000, 1000],
        [750, 250, null, null],
        [0, 0, 0, 0],
        [0, 500, 0, 500],
        [null, null, null, null],
      ];
      for (const [r0, r1, u0, u1] of cases) {
        const { pct0, pct1 } = computeReservePcts(r0, r1, u0, u1);
        expect(pct0 + pct1).toBeCloseTo(100);
      }
    });
  });
});

// computeThresholdLines

describe("computeThresholdLines", () => {
  describe("normal operation", () => {
    it("returns correct bounds for 1000 bps threshold (T=0.1)", () => {
      const lines = computeThresholdLines(1000, 40000);
      expect(lines).not.toBeNull();
      // 100/(2-0.1) = 100/1.9 ≈ 52.63% — token0 excess upper line
      expect(lines!.threshold0Upper).toBeCloseTo(52.63, 1);
      // 100/(2+0.1) = 100/2.1 ≈ 47.62% — token0 shortage lower line
      expect(lines!.threshold0Lower).toBeCloseTo(47.62, 1);
      // tank1 complements
      expect(lines!.threshold1Lower).toBeCloseTo(100 - 52.63, 1);
      expect(lines!.threshold1Upper).toBeCloseTo(100 - 47.62, 1);
    });

    it("returns correct bounds for 5000 bps threshold (T=0.5)", () => {
      // At T=0.5, critical reserves sit at r1/r0 = 1±T (oracle=1 for a
      // stable/stable pair), so usd1/usd0 = 1±T and usd0 share = 1/(2±T).
      // The formula used to read (1±T)/(2±T), which gave 33.3% / 60% —
      // the visualization then drew dashed lines WIDER than the actual
      // breach boundary (a 38% share reads inside the band but is
      // actually past the 40% line).
      const lines = computeThresholdLines(5000, 40000);
      expect(lines).not.toBeNull();
      // 100/(2-0.5) = 100/1.5 ≈ 66.67%
      expect(lines!.threshold0Upper).toBeCloseTo(66.67, 1);
      // 100/(2+0.5) = 100/2.5 = 40%
      expect(lines!.threshold0Lower).toBeCloseTo(40, 1);
      expect(lines!.threshold1Lower).toBeCloseTo(33.33, 1);
      expect(lines!.threshold1Upper).toBeCloseTo(60, 1);
    });

    it("matches the indexer priceDifference formula at the boundary", () => {
      // Sanity check against src/indexer-envio/src/priceDifference.ts:
      // priceDifference = |r1/r0 / oracleRef − 1|. With oracleRef=1 and
      // r1/r0 = 1+T, priceDifference = T (exactly at threshold). The bar
      // fill for token0 at that point must match threshold0Lower.
      const T = 0.5;
      const r0 = 100;
      const r1 = r0 * (1 + T); // boundary: r1/r0 = 1.5, priceDifference = 0.5 = T
      const usd0 = r0; // oracle = 1 → usd_price = 1 for both tokens
      const usd1 = r1;
      const x0 = (usd0 / (usd0 + usd1)) * 100; // = 40%
      const lines = computeThresholdLines(T * 10000, usd0 + usd1);
      expect(lines).not.toBeNull();
      expect(lines!.threshold0Lower).toBeCloseTo(x0, 2);
    });

    it("equilibrium (50%) is always inside the safe zone", () => {
      for (const bps of [100, 500, 1000, 3000, 5000, 9000]) {
        const lines = computeThresholdLines(bps, 10000);
        expect(lines).not.toBeNull();
        expect(lines!.threshold0Lower).toBeLessThan(50);
        expect(lines!.threshold0Upper).toBeGreaterThan(50);
        expect(lines!.threshold1Lower).toBeLessThan(50);
        expect(lines!.threshold1Upper).toBeGreaterThan(50);
      }
    });

    it("band widths are equal for both tanks", () => {
      const lines = computeThresholdLines(2000, 10000);
      expect(lines).not.toBeNull();
      const width0 = lines!.threshold0Upper - lines!.threshold0Lower;
      const width1 = lines!.threshold1Upper - lines!.threshold1Lower;
      expect(width0).toBeCloseTo(width1);
    });

    it("complements: threshold0Upper + threshold1Lower = 100", () => {
      const lines = computeThresholdLines(3000, 10000);
      expect(lines).not.toBeNull();
      expect(lines!.threshold0Upper + lines!.threshold1Lower).toBeCloseTo(100);
      expect(lines!.threshold0Lower + lines!.threshold1Upper).toBeCloseTo(100);
    });
  });

  describe("null / disabled cases", () => {
    it("returns null when usdTotal is null (no oracle, raw count in use)", () => {
      expect(computeThresholdLines(1000, null)).toBeNull();
    });

    it("returns null when rebalanceThreshold is null", () => {
      expect(computeThresholdLines(null, 10000)).toBeNull();
    });

    it("returns null when rebalanceThreshold is 0", () => {
      expect(computeThresholdLines(0, 10000)).toBeNull();
    });

    it("returns null when rebalanceThreshold is undefined", () => {
      expect(computeThresholdLines(undefined, 10000)).toBeNull();
    });

    it("returns null when T >= 1 (threshold >= 10000 bps)", () => {
      // At T=1, threshold0Upper = 100/(2-1) = 100% (edge of bar, not
      // meaningful as a "line"). Past T=1 the upper formula exceeds 100%
      // and has no valid rendering.
      expect(computeThresholdLines(10000, 10000)).toBeNull();
      expect(computeThresholdLines(10001, 10000)).toBeNull();
      expect(computeThresholdLines(15000, 10000)).toBeNull();
    });

    it("accepts T just below 1 (9999 bps)", () => {
      const lines = computeThresholdLines(9999, 10000);
      expect(lines).not.toBeNull();
      expect(lines!.threshold0Lower).toBeGreaterThan(0);
      expect(lines!.threshold0Upper).toBeLessThan(100);
    });
  });
});
