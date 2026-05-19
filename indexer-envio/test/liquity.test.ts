import { strict as assert } from "assert";
import contractsJson from "@mento-protocol/contracts/contracts.json" with { type: "json" };
import {
  LIQUITY_MARKETS,
  findLiquityMarketByAddressesRegistry,
  findLiquityMarketByDebtToken,
  findLiquityMarketByEventSource,
  isLiquidityStrategyAddress,
  makeCollateralId,
} from "../src/handlers/liquity/config";
import {
  computeCollateralRatioBps,
  floorInterestRateBracket,
} from "../src/handlers/liquity/math";
import {
  TROVE_STATUS,
  applySystemDebtDelta,
  isOpenStatus,
  moveInterestRateBracketDebt,
  reclassifyTrovesForLoadedParams,
  statusFromDebt,
  tracksIndividualInterest,
  transitionTroveStatus,
} from "../src/handlers/liquity/troves";
import { makeLiquityInstance } from "../src/handlers/liquity/bootstrap";
import { pendingTroveKey } from "../src/handlers/liquity/keys";

describe("Liquity market loader (contracts.json-backed)", () => {
  // Type narrowing for the contracts.json subpath import. The package's
  // declared type is too generic for direct access patterns.
  const celoMainnet = (
    contractsJson as Record<
      string,
      Record<string, Record<string, { address: string }>>
    >
  )["42220"]?.mainnet;

  it("assembles 3 markets for Celo mainnet with contiguous collIndex", () => {
    assert.equal(LIQUITY_MARKETS.length, 3);
    const collIndices = LIQUITY_MARKETS.map((m) => m.collIndex).sort();
    assert.deepEqual(collIndices, [0, 1, 2]);
    for (const market of LIQUITY_MARKETS) {
      assert.equal(market.chainId, 42220);
      assert.equal(market.slug, market.symbol.toLowerCase());
    }
  });

  it("derives every protocol address from @mento-protocol/contracts", () => {
    assert.ok(celoMainnet, "contracts.json missing 42220.mainnet namespace");
    // Most addresses live under the `${Role}v300${Symbol}` convention.
    // StabilityPool is the exception — the v300-suffixed entries point at
    // stale earlier deployments; the no-suffix `StabilityPool${Symbol}`
    // entries match `AddressesRegistry.stabilityPool()` on-chain. Drift
    // detected here means the package shape changed or a market's
    // canonical address moved.
    const v300RoleByField = {
      collateralRegistry: "CollateralRegistry",
      troveManager: "TroveManager",
      borrowerOperations: "BorrowerOperations",
      troveNFT: "TroveNFT",
      sortedTroves: "SortedTroves",
      activePool: "ActivePool",
      defaultPool: "DefaultPool",
      collSurplusPool: "CollSurplusPool",
      addressesRegistry: "AddressesRegistry",
      systemParams: "SystemParams",
    } as const;
    for (const market of LIQUITY_MARKETS) {
      for (const [field, role] of Object.entries(v300RoleByField) as Array<
        [keyof typeof v300RoleByField, string]
      >) {
        const key = `${role}v300${market.symbol}`;
        const expected = celoMainnet[key]?.address?.toLowerCase();
        assert.ok(
          expected,
          `${key} missing from @mento-protocol/contracts — bump package or fix naming convention`,
        );
        assert.equal(
          market[field],
          expected,
          `market.${field} drift for ${market.symbol}`,
        );
      }
      // StabilityPool uses the no-suffix package key.
      const spKey = `StabilityPool${market.symbol}`;
      const spExpected = celoMainnet[spKey]?.address?.toLowerCase();
      assert.ok(
        spExpected,
        `${spKey} missing from @mento-protocol/contracts — bump package or fix naming convention`,
      );
      assert.equal(
        market.stabilityPool,
        spExpected,
        `market.stabilityPool drift for ${market.symbol}`,
      );
      // Debt token lives under the bare symbol key.
      const debtExpected = celoMainnet[market.symbol]?.address?.toLowerCase();
      assert.ok(
        debtExpected,
        `${market.symbol} debt-token entry missing from @mento-protocol/contracts`,
      );
      assert.equal(
        market.debtToken,
        debtExpected,
        `market.debtToken drift for ${market.symbol}`,
      );
      // CDPLiquidityStrategy is shared across all markets.
      assert.equal(
        market.cdpLiquidityStrategy,
        celoMainnet.CDPLiquidityStrategy?.address?.toLowerCase(),
      );
    }
  });

  it("rejects zero / placeholder addresses across every market field", () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const PLACEHOLDER_PREFIX = "0xdead";
    const fieldsToCheck = [
      "debtToken",
      "collToken",
      "collateralRegistry",
      "troveManager",
      "stabilityPool",
      "borrowerOperations",
      "troveNFT",
      "sortedTroves",
      "activePool",
      "defaultPool",
      "collSurplusPool",
      "addressesRegistry",
      "systemParams",
      "cdpLiquidityStrategy",
    ] as const;
    for (const market of LIQUITY_MARKETS) {
      for (const field of fieldsToCheck) {
        const value = market[field];
        assert.notEqual(
          value,
          ZERO,
          `${market.symbol}.${field} is zero address`,
        );
        assert.ok(
          !value.toLowerCase().startsWith(PLACEHOLDER_PREFIX),
          `${market.symbol}.${field} looks like a placeholder: ${value}`,
        );
        assert.match(
          value,
          /^0x[0-9a-f]{40}$/,
          `${market.symbol}.${field} not normalized: ${value}`,
        );
      }
    }
  });

  it("pins GBPm SystemParams to the v300 deployment", () => {
    // Regression test for the silent two-month bug: the indexer was pointed
    // at a dead address (`0xddd2de…`, devnet leftover) and every event for
    // every GBPm trove fell through to ZOMBIE because no parameter loaded.
    // If a future agent regresses the systemParams source again, this fails
    // at test time, not after a wasted deploy.
    const gbpm = LIQUITY_MARKETS.find((m) => m.symbol === "GBPm");
    assert.ok(gbpm, "GBPm market missing");
    assert.equal(
      gbpm.systemParams,
      "0x064d8bcc79711cf51df7ca0a7fe531a271cd74e9",
      "GBPm systemParams drifted from SystemParamsv300GBPm",
    );
  });
});

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

  it("identifies only unbatched troves as individual interest-bracket rows", () => {
    assert.equal(
      tracksIndividualInterest({ interestBatchId: undefined }),
      true,
    );
    assert.equal(
      tracksIndividualInterest({ interestBatchId: "42220-0xbatch" }),
      false,
    );
  });

  it("reclassifies fail-closed troves after system params load", async () => {
    const collateralId = "42220-0xabc";
    const baseTrove = {
      id: "t",
      chainId: 42220,
      collateralId,
      troveId: "0x1",
      owner: "0x0000000000000000000000000000000000000000",
      previousOwner: "0x0000000000000000000000000000000000000000",
      status: TROVE_STATUS.ZOMBIE,
      debt: 150n,
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
    const troves = new Map([
      [baseTrove.id, baseTrove],
      [
        "low",
        {
          ...baseTrove,
          id: "low",
          troveId: "0x2",
          status: TROVE_STATUS.ACTIVE,
          debt: 50n,
        },
      ],
    ]);
    const instances = new Map([
      [
        collateralId,
        {
          ...makeLiquityInstance(collateralId, 42220, 0n),
          activeTroveCount: 1,
          spDeposits: 150n,
          spHeadroom: -1n,
        },
      ],
    ]);
    const context = {
      LiquityInstance: {
        get: async (id: string) => instances.get(id),
        set: (entity: ReturnType<typeof makeLiquityInstance>) =>
          instances.set(entity.id, entity),
      },
      Trove: {
        set: (entity: typeof baseTrove) => troves.set(entity.id, entity),
        getWhere: async (args: { collateralId: { _eq: string } }) => {
          assert.deepEqual(Object.keys(args), ["collateralId"]);
          return [...troves.values()].filter(
            (trove) => trove.collateralId === args.collateralId._eq,
          );
        },
      },
    };

    await reclassifyTrovesForLoadedParams(context, collateralId, 100n, 40n);

    assert.equal(troves.get("t")?.status, TROVE_STATUS.ACTIVE);
    assert.equal(troves.get("low")?.status, TROVE_STATUS.ZOMBIE);
    assert.equal(instances.get(collateralId)?.activeTroveCount, 1);
    assert.equal(instances.get(collateralId)?.spHeadroom, 110n);

    instances.set(collateralId, {
      ...makeLiquityInstance(collateralId, 42220, 0n),
      spDeposits: 0n,
      spHeadroom: -1n,
    });
    await reclassifyTrovesForLoadedParams(context, collateralId, 100n, 40n);
    assert.equal(instances.get(collateralId)?.spHeadroom, -40n);
  });

  it("decrements activeTroveCount when reclassify demotes all active troves to zombie", async () => {
    // Regression: the previous implementation passed `nextInstance` (not
    // `transitioned.instance`) into `applySystemDebtDelta`, so the
    // activeTroveCount decrement from `transitionTroveStatus` was silently
    // dropped. Two active troves both dropping below minDebt have no
    // counterbalancing zombie→active flip, so the count must hit 0.
    const collateralId = "42220-0xdef";
    const baseTrove = {
      id: "a",
      chainId: 42220,
      collateralId,
      troveId: "0x1",
      owner: "0x0000000000000000000000000000000000000000",
      previousOwner: "0x0000000000000000000000000000000000000000",
      status: TROVE_STATUS.ACTIVE,
      debt: 50n,
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
    const troves = new Map([
      [baseTrove.id, baseTrove],
      [
        "b",
        {
          ...baseTrove,
          id: "b",
          troveId: "0x2",
          status: TROVE_STATUS.ACTIVE,
          debt: 70n,
        },
      ],
    ]);
    const instances = new Map([
      [
        collateralId,
        {
          ...makeLiquityInstance(collateralId, 42220, 0n),
          activeTroveCount: 2,
          systemDebt: 120n,
          spDeposits: 0n,
          spHeadroom: -1n,
        },
      ],
    ]);
    const context = {
      LiquityInstance: {
        get: async (id: string) => instances.get(id),
        set: (entity: ReturnType<typeof makeLiquityInstance>) =>
          instances.set(entity.id, entity),
      },
      Trove: {
        set: (entity: typeof baseTrove) => troves.set(entity.id, entity),
        getWhere: async (args: { collateralId: { _eq: string } }) =>
          [...troves.values()].filter(
            (trove) => trove.collateralId === args.collateralId._eq,
          ),
      },
    };

    await reclassifyTrovesForLoadedParams(context, collateralId, 100n, 40n);

    assert.equal(troves.get("a")?.status, TROVE_STATUS.ZOMBIE);
    assert.equal(troves.get("b")?.status, TROVE_STATUS.ZOMBIE);
    assert.equal(instances.get(collateralId)?.activeTroveCount, 0);
    // active↔zombie flips are open↔open, so systemDebt must NOT move.
    assert.equal(instances.get(collateralId)?.systemDebt, 120n);
  });

  describe("isLiquidityStrategyAddress", () => {
    it("matches the strategy address from config.markets, case-insensitive", () => {
      const market = LIQUITY_MARKETS[0]!;
      // The discriminator is what we use to split rebalance-driven
      // redemptions from user-driven ones in the Redemption handler.
      assert.equal(
        isLiquidityStrategyAddress(
          market.chainId,
          market.cdpLiquidityStrategy.toUpperCase(),
        ),
        true,
      );
      assert.equal(
        isLiquidityStrategyAddress(market.chainId, market.cdpLiquidityStrategy),
        true,
      );
    });

    it("returns false for non-strategy addresses, undefined, or wrong chain", () => {
      const market = LIQUITY_MARKETS[0]!;
      assert.equal(
        isLiquidityStrategyAddress(market.chainId, market.troveManager),
        false,
      );
      assert.equal(
        isLiquidityStrategyAddress(market.chainId, undefined),
        false,
      );
      assert.equal(isLiquidityStrategyAddress(market.chainId, null), false);
      assert.equal(
        isLiquidityStrategyAddress(99999, market.cdpLiquidityStrategy),
        false,
      );
    });
  });

  describe("applySystemDebtDelta", () => {
    const baseInstance = () => ({
      ...makeLiquityInstance("42220-0xabc", 42220, 0n),
      systemDebt: 1000n,
    });

    it("flags active/zombie as open and closed/liquidated/redeemed as not", () => {
      assert.equal(isOpenStatus(TROVE_STATUS.ACTIVE), true);
      assert.equal(isOpenStatus(TROVE_STATUS.ZOMBIE), true);
      assert.equal(isOpenStatus(TROVE_STATUS.CLOSED), false);
      assert.equal(isOpenStatus(TROVE_STATUS.LIQUIDATED), false);
      assert.equal(isOpenStatus(TROVE_STATUS.REDEEMED), false);
    });

    it("placeholder open: closed→active with debt 0→1000 adds 1000", () => {
      // Two-step OPEN_TROVE flow: TroveOperation transitions status, then
      // TroveUpdated arrives with the real debt. This test mimics the second
      // call only — the first call's prev/next are both 0-contribution.
      const next = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ACTIVE, debt: 0n },
        { status: TROVE_STATUS.ACTIVE, debt: 1000n },
      );
      assert.equal(next.systemDebt, 2000n);
    });

    it("close-trove: active→closed subtracts the trove's debt", () => {
      const next = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ACTIVE, debt: 700n },
        { status: TROVE_STATUS.CLOSED, debt: 0n },
      );
      assert.equal(next.systemDebt, 300n);
    });

    it("liquidation: active→liquidated subtracts the trove's debt", () => {
      const next = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ACTIVE, debt: 400n },
        { status: TROVE_STATUS.LIQUIDATED, debt: 400n },
      );
      assert.equal(next.systemDebt, 600n);
    });

    it("intra-open flip (active↔zombie) with identical debt is a no-op", () => {
      // reclassifyTrovesForLoadedParams flips troves between active/zombie
      // based on minDebt — both are open, so systemDebt must NOT change.
      const before = baseInstance();
      const after = applySystemDebtDelta(
        before,
        { status: TROVE_STATUS.ACTIVE, debt: 500n },
        { status: TROVE_STATUS.ZOMBIE, debt: 500n },
      );
      assert.equal(after, before);
    });

    it("debt change on open trove (no status flip) applies the delta", () => {
      const next = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ACTIVE, debt: 500n },
        { status: TROVE_STATUS.ACTIVE, debt: 700n },
      );
      assert.equal(next.systemDebt, 1200n);
    });

    it("zombie→active with debt going above minDebt applies the delta", () => {
      // After a top-up that lifts a zombie back above minDebt.
      const next = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ZOMBIE, debt: 50n },
        { status: TROVE_STATUS.ACTIVE, debt: 200n },
      );
      assert.equal(next.systemDebt, 1150n);
    });

    it("redeem-to-zero: active→redeemed at debt 0 subtracts the full prev debt", () => {
      const next = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ACTIVE, debt: 800n },
        { status: TROVE_STATUS.REDEEMED, debt: 0n },
      );
      assert.equal(next.systemDebt, 200n);
    });

    it("returns the same instance reference when contributions are equal", () => {
      const before = baseInstance();
      const after = applySystemDebtDelta(
        before,
        { status: TROVE_STATUS.CLOSED, debt: 0n },
        { status: TROVE_STATUS.LIQUIDATED, debt: 0n },
      );
      assert.equal(after, before);
    });
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

  it("scopes pending trove rows by collateral as well as tx and trove id", () => {
    const txHash = "0xabc";
    assert.notEqual(
      pendingTroveKey(42220, txHash, "42220-0x111", "0x1"),
      pendingTroveKey(42220, txHash, "42220-0x222", "0x1"),
    );
  });
});
