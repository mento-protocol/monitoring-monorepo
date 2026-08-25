import { describe, expect, it } from "vitest";
import { hasUnindexedSusdsHolding } from "@/lib/reserve-yield-susds-coverage";
import type { ReserveYieldHolding } from "@/lib/reserve-yield";

const TRACKED_WALLET = "0xd0697f70e79476195b742d5afab14be50f98cc1e";

function susdsHolding(
  overrides: Partial<ReserveYieldHolding> = {},
): ReserveYieldHolding {
  return {
    id: "susds-source",
    assetSymbol: "sUSDS",
    chain: "ethereum",
    sourceType: "wallet",
    sourceLabel: "Reserve Safe",
    identifier: TRACKED_WALLET,
    custodianType: "self-custody",
    balance: 1_000,
    hasTokenBalance: true,
    principalUsd: 1_000,
    earnedYieldUsd: null,
    apyPercent: null,
    yieldModel: "Yield source pending",
    dailyRunRateUsd: null,
    next30dUsd: null,
    next365dUsd: null,
    annualRunRateUsd: null,
    ...overrides,
  };
}

describe("hasUnindexedSusdsHolding", () => {
  it.each([
    { balance: 1_000, principalUsd: 0 },
    { balance: 0, principalUsd: 1_000 },
    { balance: -1_000, principalUsd: 0 },
    { balance: 0, principalUsd: -1_000 },
  ])(
    "detects nonzero current exposure outside indexed wallets ($balance, $principalUsd)",
    ({ balance, principalUsd }) => {
      expect(
        hasUnindexedSusdsHolding([
          susdsHolding({
            identifier: "0x0000000000000000000000000000000000000001",
            balance,
            principalUsd,
          }),
        ]),
      ).toBe(true);
    },
  );

  it("does not treat the tracked Ethereum address as indexed on another chain", () => {
    expect(hasUnindexedSusdsHolding([susdsHolding({ chain: "polygon" })])).toBe(
      true,
    );
  });

  it("allows an explicit-zero unindexed source beside indexed exposure", () => {
    expect(
      hasUnindexedSusdsHolding([
        susdsHolding(),
        susdsHolding({
          id: "zero-unindexed-source",
          identifier: "0x0000000000000000000000000000000000000001",
          balance: 0,
          principalUsd: 0,
        }),
      ]),
    ).toBe(false);
  });

  it("fails an asset fallback with nonzero exposure and no identifier", () => {
    expect(
      hasUnindexedSusdsHolding([
        susdsHolding({
          sourceType: "asset",
          identifier: null,
          balance: 1,
          principalUsd: 1,
        }),
      ]),
    ).toBe(true);
  });
});
