import { describe, expect, it } from "vitest";

import {
  computeStructuralSaturation,
  deriveReferenceSize,
  FPMM_L0_WINDOW_SECONDS,
  FPMM_L1_WINDOW_SECONDS,
  normalizeRawAmountTo15Decimals,
  summarizeSwapFlow,
} from "../src/peg/structural.js";

const UNIT = 10n ** 15n;

function limit(
  overrides: Partial<{
    limit0: string;
    limit1: string;
    netflow0: string;
    netflow1: string;
    lastUpdated0: string;
    lastUpdated1: string;
  }> = {},
) {
  return {
    limit0: (100n * UNIT).toString(),
    limit1: (1_000n * UNIT).toString(),
    netflow0: (20n * UNIT).toString(),
    netflow1: (500n * UNIT).toString(),
    lastUpdated0: "100000",
    lastUpdated1: "100000",
    ...overrides,
  };
}

describe("computeStructuralSaturation", () => {
  it("returns null when both windows are disabled", () => {
    const result = computeStructuralSaturation(
      limit({ limit0: "0", limit1: "0" }),
      100_000n,
    );

    expect(result.saturationFraction).toBeNull();
    expect(result.controllingWindow).toBeNull();
  });

  it("takes the maximum positive monitored-token inflow fraction", () => {
    const result = computeStructuralSaturation(limit(), 100_000n);

    expect(result.windows.l0.saturationFraction).toBe(0.2);
    expect(result.windows.l1.saturationFraction).toBe(0.5);
    expect(result.saturationFraction).toBe(0.5);
    expect(result.controllingWindow).toBe("L1");
  });

  it("clamps negative netflow (outflow) to zero", () => {
    const result = computeStructuralSaturation(
      limit({ netflow0: (-90n * UNIT).toString(), limit1: "0" }),
      100_000n,
    );

    expect(result.saturationFraction).toBe(0);
  });

  it("rejects negative limits while keeping zero as the disabled sentinel", () => {
    expect(() =>
      computeStructuralSaturation(limit({ limit0: "-1" }), 100_000n),
    ).toThrow(/non-negative/);
  });

  it("rejects saturation values outside the finite metric range", () => {
    expect(() =>
      computeStructuralSaturation(
        limit({
          limit0: "1",
          limit1: "0",
          netflow0: `1${"0".repeat(400)}`,
        }),
        100_000n,
      ),
    ).toThrow(/outside the numeric range/);
  });

  it("keeps equality inside each window and expires it one second later", () => {
    const row = limit({
      lastUpdated0: "1000",
      lastUpdated1: "1000",
    });
    const l0Boundary = 1_000n + BigInt(FPMM_L0_WINDOW_SECONDS);
    const l1Boundary = 1_000n + BigInt(FPMM_L1_WINDOW_SECONDS);

    expect(computeStructuralSaturation(row, l0Boundary).windows.l0.active).toBe(
      true,
    );
    expect(
      computeStructuralSaturation(row, l0Boundary + 1n).windows.l0.active,
    ).toBe(false);
    expect(computeStructuralSaturation(row, l1Boundary).windows.l1.active).toBe(
      true,
    );
    expect(
      computeStructuralSaturation(row, l1Boundary + 1n).windows.l1.active,
    ).toBe(false);
  });

  it("uses the remaining active window when the other has expired", () => {
    const result = computeStructuralSaturation(
      limit({ lastUpdated0: "1000", lastUpdated1: "100000" }),
      100_000n,
    );

    expect(result.windows.l0.active).toBe(false);
    expect(result.saturationFraction).toBe(0.5);
    expect(result.controllingWindow).toBe("L1");
  });
});

describe("deriveReferenceSize", () => {
  it("falls back to the positive configured cap when limits are disabled", () => {
    expect(deriveReferenceSize({ limit0: "0", limit1: "0" }, 25_000)).toBe(
      25_000,
    );
  });

  it("takes the minimum positive enforced limit and configured cap", () => {
    expect(
      deriveReferenceSize(
        {
          limit0: (50_000n * UNIT).toString(),
          limit1: (10_000n * UNIT).toString(),
        },
        25_000,
      ),
    ).toBe(10_000);
    expect(
      deriveReferenceSize(
        { limit0: "0", limit1: (50_000n * UNIT).toString() },
        25_000,
      ),
    ).toBe(25_000);
  });

  it("refuses a zero configured cap so refSize cannot be zero", () => {
    expect(() => deriveReferenceSize({ limit0: "0", limit1: "0" }, 0)).toThrow(
      "must be positive",
    );
  });

  it("rejects a negative limit instead of treating it as disabled", () => {
    expect(() =>
      deriveReferenceSize({ limit0: "-1", limit1: "0" }, 25_000),
    ).toThrow(/non-negative/);
  });
});

describe("swap advisory summary", () => {
  it("normalizes 6- and 18-decimal raw amounts to the 15-decimal limit scale", () => {
    expect(normalizeRawAmountTo15Decimals(1_000_000n, 6)).toBe(UNIT);
    expect(normalizeRawAmountTo15Decimals(10n ** 18n, 18)).toBe(UNIT);
  });

  it("clamps an advisory net outflow to zero positive inflow", () => {
    const result = summarizeSwapFlow(
      {
        token0: "0xaaa",
        token1: "0xbbb",
        token0Decimals: 6,
        token1Decimals: 18,
      },
      "0xaaa",
      [
        {
          caller: "0x111",
          amount0In: "1000000",
          amount1In: "0",
          amount0Out: "2000000",
          amount1Out: "0",
        },
      ],
    );

    expect(result.netInflow15).toBe(-UNIT);
    expect(result.positiveNetInflow15).toBe(0n);
  });

  it("counts unique callers case-insensitively for advisory display", () => {
    const result = summarizeSwapFlow(
      {
        token0: "0xaaa",
        token1: "0xbbb",
        token0Decimals: 6,
        token1Decimals: 18,
      },
      "0xBbB",
      [
        {
          caller: "0xAbC",
          amount0In: "0",
          amount1In: "1000000000000000000",
          amount0Out: "0",
          amount1Out: "0",
        },
        {
          caller: "0xabc",
          amount0In: "0",
          amount1In: "0",
          amount0Out: "0",
          amount1Out: "500000000000000000",
        },
        {
          caller: "0xdef",
          amount0In: "0",
          amount1In: "1000000000000000000",
          amount0Out: "0",
          amount1Out: "0",
        },
      ],
    );

    expect(result.grossInflow15).toBe(2n * UNIT);
    expect(result.grossOutflow15).toBe(UNIT / 2n);
    expect(result.uniqueCallerCount).toBe(2);
  });
});
