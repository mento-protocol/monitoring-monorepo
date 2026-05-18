import { strict as assert } from "assert";
import {
  LIQUITY_MARKETS,
  findLiquityMarketByAddressesRegistry,
  findLiquityMarketByDebtToken,
  findLiquityMarketByEventSource,
  makeCollateralId,
} from "../src/handlers/liquity/config";
import {
  computeCollateralRatioBps,
  floorInterestRateBracket,
} from "../src/handlers/liquity/math";
import {
  TROVE_STATUS,
  moveInterestRateBracketDebt,
  statusFromDebt,
  transitionTroveStatus,
} from "../src/handlers/liquity/troves";
import { makeLiquityInstance } from "../src/handlers/liquity/bootstrap";

describe("Liquity CDP helpers", () => {
  it("routes every configured Celo market by all event source contracts", () => {
    assert.equal(LIQUITY_MARKETS.length, 3);
    for (const market of LIQUITY_MARKETS) {
      const id = makeCollateralId(market);
      assert.equal(
        findLiquityMarketByEventSource(market.chainId, market.troveManager),
        market,
      );
      assert.equal(
        findLiquityMarketByEventSource(market.chainId, market.stabilityPool),
        market,
      );
      assert.equal(
        findLiquityMarketByEventSource(market.chainId, market.troveNFT),
        market,
      );
      assert.equal(
        findLiquityMarketByDebtToken(market.chainId, market.debtToken),
        market,
      );
      assert.equal(
        findLiquityMarketByAddressesRegistry(
          market.chainId,
          market.addressesRegistry,
        ),
        market,
      );
      assert.match(id, /^42220-0x[0-9a-f]{40}$/);
    }
  });

  it("computes CDP collateral ratios in bps from collateral/debt price", () => {
    const d18 = 10n ** 18n;
    assert.equal(
      computeCollateralRatioBps({
        coll: 200n * d18,
        debt: 100n * d18,
        collateralDebtPriceD18: (75n * d18) / 100n,
      }),
      15000,
    );
    assert.equal(
      computeCollateralRatioBps({
        coll: 200n * d18,
        debt: 0n,
        collateralDebtPriceD18: d18,
      }),
      -1,
    );
  });

  it("floors interest-rate brackets at 0.1 percentage-point precision", () => {
    const d18 = 10n ** 18n;
    assert.equal(
      floorInterestRateBracket((5123n * d18) / 100000n),
      51n * 10n ** 15n,
    );
    assert.equal(
      floorInterestRateBracket((5000n * d18) / 100000n),
      50n * 10n ** 15n,
    );
  });

  it("treats sub-minimum post-redemption debt as zombie, not active", () => {
    assert.equal(statusFromDebt(0n, 100n), TROVE_STATUS.REDEEMED);
    assert.equal(statusFromDebt(99n, 100n), TROVE_STATUS.ZOMBIE);
    assert.equal(statusFromDebt(100n, 100n), TROVE_STATUS.ACTIVE);
  });

  it("updates active trove count exactly on active boundary crossings", () => {
    const instance = makeLiquityInstance("42220-0xabc", 42220, 3_600n);
    const baseTrove = {
      id: "t",
      chainId: 42220,
      collateralId: instance.id,
      troveId: "0x1",
      owner: "0x0000000000000000000000000000000000000000",
      previousOwner: "0x0000000000000000000000000000000000000000",
      status: TROVE_STATUS.CLOSED,
      debt: 0n,
      coll: 0n,
      stake: 0n,
      snapshotOfTotalCollRedist: 0n,
      snapshotOfTotalDebtRedist: 0n,
      interestRate: 0n,
      interestBatchId: undefined,
      batchDebtShares: 0n,
      icrBps: 0,
      liquidatedColl: undefined,
      liquidatedDebt: undefined,
      collSurplus: undefined,
      priceAtLiquidation: undefined,
      redemptionCount: 0,
      redeemedColl: 0n,
      redeemedDebt: 0n,
      redemptionFeePaidCum: 0n,
      openedAt: 0n,
      openedAtBlock: 0n,
      openedTxHash: "",
      closedAt: undefined,
      closedAtBlock: undefined,
      closedTxHash: undefined,
      lastUserActionAt: 0n,
      lastUpdatedAt: 0n,
      lastUpdatedBlock: 0n,
    };
    const opened = transitionTroveStatus(
      baseTrove,
      TROVE_STATUS.ACTIVE,
      instance,
    );
    assert.equal(opened.instance.activeTroveCount, 1);
    const stillActive = transitionTroveStatus(
      opened.trove,
      TROVE_STATUS.ACTIVE,
      opened.instance,
    );
    assert.equal(stillActive.instance.activeTroveCount, 1);
    const zombie = transitionTroveStatus(
      stillActive.trove,
      TROVE_STATUS.ZOMBIE,
      stillActive.instance,
    );
    assert.equal(zombie.instance.activeTroveCount, 0);
  });

  it("floors interest bracket debt and weighted debt when debits overshoot", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const context = {
      InterestRateBracket: {
        get: async (id: string) => rows.get(id),
        set: (entity: Record<string, unknown>) =>
          rows.set(String(entity.id), entity),
      },
    } as unknown as Parameters<typeof moveInterestRateBracketDebt>[0];
    const rate = 5n * 10n ** 16n;
    await moveInterestRateBracketDebt(context, {
      collateralId: "42220-0xabc",
      prevRate: 0n,
      nextRate: rate,
      prevDebt: 0n,
      nextDebt: 100n,
      timestamp: 1n,
    });
    await moveInterestRateBracketDebt(context, {
      collateralId: "42220-0xabc",
      prevRate: rate,
      nextRate: 0n,
      prevDebt: 101n,
      nextDebt: 0n,
      timestamp: 2n,
    });
    const bracket = rows.get(`42220-0xabc-${rate}`);
    assert.equal(bracket?.totalDebt, 0n);
    assert.equal(bracket?.sumDebtTimesRateD36, 0n);
  });
});
