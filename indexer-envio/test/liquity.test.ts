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
  computeTroveIcrBps,
  computeTroveOperationSnapshot,
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
import { replayBatchedTroveUpdate } from "../src/handlers/liquity/batchReplay";
import {
  applyTroveUpdatedFields,
  moveTroveUpdatedInterestRateBracketDebt,
} from "../src/handlers/liquity/troveUpdates";
import { OP } from "../src/handlers/liquity/operations";

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
      const priceFeedExpected =
        celoMainnet[`FXPriceFeedProxy${market.symbol}`]?.address?.toLowerCase();
      assert.ok(
        priceFeedExpected,
        `FXPriceFeedProxy${market.symbol} missing from @mento-protocol/contracts`,
      );
      assert.equal(
        market.priceFeed,
        priceFeedExpected,
        `market.priceFeed drift for ${market.symbol}`,
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
      "priceFeed",
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
    assert.equal(
      computeTroveIcrBps({
        coll: 2667n * d18,
        debt: 1000n * d18,
        price: 749400479616306954n,
      }),
      19986,
    );
    assert.equal(
      computeTroveIcrBps({
        coll: 2667n * d18,
        debt: 1000n * d18,
        price: null,
      }),
      -1,
    );
    assert.equal(
      computeTroveIcrBps({
        coll: 1000n * d18,
        debt: 1n,
        price: d18,
      }),
      2_147_483_647,
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

  describe("computeTroveOperationSnapshot", () => {
    const NO_REDIST = {
      debtIncreaseFromRedist: 0n,
      collIncreaseFromRedist: 0n,
      debtIncreaseFromUpfrontFee: 0n,
    };

    it("OPEN_TROVE: from a zero starting position adds the borrowed debt and posted collateral", () => {
      const snap = computeTroveOperationSnapshot({
        debtBefore: 0n,
        collBefore: 0n,
        debtChange: 5_000n,
        collChange: 10_000n,
        ...NO_REDIST,
      });
      assert.equal(snap.debtAfter, 5_000n);
      assert.equal(snap.collAfter, 10_000n);
    });

    it("ADJUST_TROVE repayment: signed-negative debt delta reduces debtAfter, leaves coll untouched", () => {
      const snap = computeTroveOperationSnapshot({
        debtBefore: 5_000n,
        collBefore: 10_000n,
        debtChange: -1_000n,
        collChange: 0n,
        ...NO_REDIST,
      });
      assert.equal(snap.debtAfter, 4_000n);
      assert.equal(snap.collAfter, 10_000n);
    });

    it("ADJUST_TROVE withdrawal: signed-negative coll delta reduces collAfter, leaves debt untouched", () => {
      const snap = computeTroveOperationSnapshot({
        debtBefore: 5_000n,
        collBefore: 10_000n,
        debtChange: 0n,
        collChange: -2_000n,
        ...NO_REDIST,
      });
      assert.equal(snap.debtAfter, 5_000n);
      assert.equal(snap.collAfter, 8_000n);
    });

    it("CLOSE_TROVE: a full repayment lands at debtAfter == 0", () => {
      const snap = computeTroveOperationSnapshot({
        debtBefore: 5_000n,
        collBefore: 10_000n,
        debtChange: -5_000n,
        collChange: -10_000n,
        ...NO_REDIST,
      });
      assert.equal(snap.debtAfter, 0n);
      assert.equal(snap.collAfter, 0n);
    });

    it("upfront fee materializes into debtAfter on top of the change", () => {
      // The ABI exposes the upfront fee separately so the UI can disambiguate
      // borrowed-principal from fee-accrual. Both contribute to debtAfter.
      const snap = computeTroveOperationSnapshot({
        debtBefore: 5_000n,
        collBefore: 10_000n,
        debtChange: 1_000n,
        collChange: 0n,
        debtIncreaseFromRedist: 0n,
        debtIncreaseFromUpfrontFee: 50n,
        collIncreaseFromRedist: 0n,
      });
      assert.equal(snap.debtAfter, 6_050n);
      assert.equal(snap.collAfter, 10_000n);
    });

    it("pending redistribution materializes when an operation touches the trove", () => {
      // Critical correctness case: omitting these terms lets debtAfter drift
      // from the value the subsequent TroveUpdated will write. Both debt and
      // coll redist terms are unsigned (pending positive deltas).
      const snap = computeTroveOperationSnapshot({
        debtBefore: 5_000n,
        collBefore: 10_000n,
        debtChange: 0n,
        collChange: 0n,
        debtIncreaseFromUpfrontFee: 0n,
        debtIncreaseFromRedist: 250n,
        collIncreaseFromRedist: 500n,
      });
      assert.equal(snap.debtAfter, 5_250n);
      assert.equal(snap.collAfter, 10_500n);
    });

    it("floors at zero if a future ABI revision overshoots the existing balance", () => {
      // Defensive: TroveOperation deltas should never push the trove below
      // zero, but if they ever do (forked contract / unexpected sequence) we
      // saturate at 0 so the snapshot can't surface a negative magnitude.
      const snap = computeTroveOperationSnapshot({
        debtBefore: 100n,
        collBefore: 100n,
        debtChange: -200n,
        collChange: -200n,
        ...NO_REDIST,
      });
      assert.equal(snap.debtAfter, 0n);
      assert.equal(snap.collAfter, 0n);
    });
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

    it("positive delta bumps mint buckets (day + cum), leaves burn untouched", () => {
      const next = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ACTIVE, debt: 500n },
        { status: TROVE_STATUS.ACTIVE, debt: 800n },
      );
      assert.equal(next.systemDebtMintedDayBucket, 300n);
      assert.equal(next.systemDebtMintedCum, 300n);
      assert.equal(next.systemDebtBurnedDayBucket, 0n);
      assert.equal(next.systemDebtBurnedCum, 0n);
    });

    it("negative delta bumps burn buckets (day + cum) with absolute value", () => {
      const next = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ACTIVE, debt: 800n },
        { status: TROVE_STATUS.CLOSED, debt: 0n },
      );
      assert.equal(next.systemDebtBurnedDayBucket, 800n);
      assert.equal(next.systemDebtBurnedCum, 800n);
      assert.equal(next.systemDebtMintedDayBucket, 0n);
      assert.equal(next.systemDebtMintedCum, 0n);
    });

    it("mint then burn accumulate independently into the same instance", () => {
      // First open: 0→1000 (mint 1000), then partial repay: 1000→700 (burn 300).
      const opened = applySystemDebtDelta(
        baseInstance(),
        { status: TROVE_STATUS.ACTIVE, debt: 0n },
        { status: TROVE_STATUS.ACTIVE, debt: 1000n },
      );
      const repaid = applySystemDebtDelta(
        opened,
        { status: TROVE_STATUS.ACTIVE, debt: 1000n },
        { status: TROVE_STATUS.ACTIVE, debt: 700n },
      );
      assert.equal(repaid.systemDebtMintedDayBucket, 1000n);
      assert.equal(repaid.systemDebtBurnedDayBucket, 300n);
      // systemDebt: 1000 (base) + 1000 - 300 = 1700.
      assert.equal(repaid.systemDebt, 1700n);
    });
  });

  describe("flushLiquitySnapshots — V3_LIQUITY StableSupplyDailySnapshot row", () => {
    const SECONDS_PER_DAY = 86_400n;

    it("writes a V3_LIQUITY snapshot row using LIQUITY_MARKETS metadata + bucketed mint/burn", async () => {
      const { flushLiquitySnapshots } =
        await import("../src/handlers/liquity/instance");
      const gbpm = LIQUITY_MARKETS.find((m) => m.symbol === "GBPm");
      assert.ok(gbpm, "GBPm market missing from registry");
      const collateralId = makeCollateralId(gbpm);
      const day0 = 1_716_336_000n; // 2024-05-22 00:00:00 UTC
      const day1 = day0 + SECONDS_PER_DAY;

      const instance = {
        ...makeLiquityInstance(collateralId, 42220, day0),
        systemDebt: 1_500_000n * 10n ** 18n,
        systemDebtMintedDayBucket: 300_000n * 10n ** 18n,
        systemDebtBurnedDayBucket: 50_000n * 10n ** 18n,
      };

      const captured: Array<Record<string, unknown>> = [];
      const ctx = {
        LiquityInstanceSnapshot: { set: () => undefined },
        LiquityInstanceDailySnapshot: { set: () => undefined },
        StableSupplyDailySnapshot: {
          set: (row: Record<string, unknown>) => captured.push(row),
        },
      };

      flushLiquitySnapshots(ctx as never, instance, day1, 1_000_000n);

      assert.equal(captured.length, 1);
      const row = captured[0];
      assert.equal(row.id, `42220-${gbpm.debtToken}-${day0}`);
      assert.equal(row.chainId, 42220);
      assert.equal(row.tokenAddress, gbpm.debtToken);
      assert.equal(row.tokenSymbol, "GBPm");
      assert.equal(row.source, "V3_LIQUITY");
      assert.equal(row.tokenDecimals, 18);
      assert.equal(row.timestamp, day0);
      assert.equal(row.totalSupply, 1_500_000n * 10n ** 18n);
      assert.equal(row.dailyMintAmount, 300_000n * 10n ** 18n);
      assert.equal(row.dailyBurnAmount, 50_000n * 10n ** 18n);
    });

    it("resets mint/burn day buckets on rollover so the next day starts at 0n", async () => {
      const { flushLiquitySnapshots } =
        await import("../src/handlers/liquity/instance");
      const gbpm = LIQUITY_MARKETS.find((m) => m.symbol === "GBPm");
      assert.ok(gbpm);
      const collateralId = makeCollateralId(gbpm);
      const day0 = 1_716_336_000n;
      const day1 = day0 + SECONDS_PER_DAY;

      const instance = {
        ...makeLiquityInstance(collateralId, 42220, day0),
        systemDebtMintedDayBucket: 100n,
        systemDebtBurnedDayBucket: 50n,
      };
      const ctx = {
        LiquityInstanceSnapshot: { set: () => undefined },
        LiquityInstanceDailySnapshot: { set: () => undefined },
        StableSupplyDailySnapshot: { set: () => undefined },
      };

      const next = flushLiquitySnapshots(ctx as never, instance, day1, 1n);
      // Day rollover happened — buckets reset to 0n.
      assert.equal(next.systemDebtMintedDayBucket, 0n);
      assert.equal(next.systemDebtBurnedDayBucket, 0n);
      // Cum survives the rollover (unchanged because flush doesn't bump cum).
      assert.equal(next.systemDebtMintedCum, 0n);
      assert.equal(next.systemDebtBurnedCum, 0n);
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

  it("moves remove-from-batch TroveUpdated debt back into the individual-rate bracket", async () => {
    const collateralId = "42220-0xabc";
    const batchedTrove = {
      id: `${collateralId}-0x1`,
      chainId: 42220,
      collateralId,
      troveId: "0x1",
      owner: "0x0000000000000000000000000000000000000000",
      previousOwner: "0x0000000000000000000000000000000000000000",
      status: TROVE_STATUS.ACTIVE,
      debt: 1_000n,
      coll: 5_000n,
      stake: 5_000n,
      snapshotOfTotalCollRedist: 0n,
      snapshotOfTotalDebtRedist: 0n,
      interestRate: 0n,
      interestBatchId: `${collateralId}-0xbatch`,
      batchDebtShares: 1_000n,
      icrBps: 0,
      liquidatedColl: undefined,
      liquidatedDebt: undefined,
      collSurplus: undefined,
      priceAtLiquidation: undefined,
      redemptionCount: 0,
      redeemedColl: 0n,
      redeemedDebt: 0n,
      redemptionFeePaidCum: 0n,
      openedAt: 1n,
      openedAtBlock: 1n,
      openedTxHash: "0xopen",
      closedAt: undefined,
      closedAtBlock: undefined,
      closedTxHash: undefined,
      lastUserActionAt: 1n,
      lastUpdatedAt: 1n,
      lastUpdatedBlock: 1n,
    };
    const rows = new Map<string, Record<string, unknown>>();
    const context = {
      InterestRateBracket: {
        get: async (id: string) => rows.get(id),
        set: (entity: Record<string, unknown>) =>
          rows.set(String(entity.id), entity),
      },
      Trove: { get: async () => undefined, set: () => undefined },
      BorrowerInfo: { get: async () => undefined, set: () => undefined },
    } as unknown as Parameters<
      typeof moveTroveUpdatedInterestRateBracketDebt
    >[0];
    const annualInterestRate = 5n * 10n ** 16n;

    await moveTroveUpdatedInterestRateBracketDebt(context, {
      collateralId,
      trove: batchedTrove,
      pendingBatchOperation: {
        operation: OP.REMOVE_FROM_BATCH,
      },
      annualInterestRate,
      debt: 1_200n,
      timestamp: 2n,
    });
    const updated = applyTroveUpdatedFields(batchedTrove, {
      debt: 1_200n,
      coll: 5_100n,
      stake: 5_100n,
      snapshotOfTotalCollRedist: 0n,
      snapshotOfTotalDebtRedist: 0n,
      annualInterestRate,
      icrBps: 0,
      blockTimestamp: 2n,
      blockNumber: 2n,
      pendingBatchOperation: {
        operation: OP.REMOVE_FROM_BATCH,
      },
    });

    assert.equal(updated.interestBatchId, undefined);
    assert.equal(updated.batchDebtShares, 0n);
    assert.equal(updated.interestRate, annualInterestRate);
    const bracket = rows.get(`${collateralId}-${annualInterestRate}`);
    assert.equal(bracket?.totalDebt, 1_200n);
    assert.equal(bracket?.sumDebtTimesRateD36, 60n * 10n ** 18n);
  });

  it("keeps remove-from-batch replay from reattaching a batch after TroveUpdated clears it", async () => {
    const chainId = 42220;
    const txHash =
      "0x00000000000000000000000000000000000000000000000000000000000000ac";
    const collateralId = "42220-0xabc";
    const troveId = "0x1";
    const pendingId = pendingTroveKey(chainId, txHash, collateralId, troveId);
    const batchId = `${collateralId}-0xbatch`;
    const troves = new Map<string, Record<string, unknown>>([
      [
        `${collateralId}-${troveId}`,
        {
          id: `${collateralId}-${troveId}`,
          chainId,
          collateralId,
          troveId,
          owner: "0x0000000000000000000000000000000000000000",
          previousOwner: "0x0000000000000000000000000000000000000000",
          status: TROVE_STATUS.ACTIVE,
          debt: 1_100n,
          coll: 5_000n,
          stake: 5_000n,
          snapshotOfTotalCollRedist: 0n,
          snapshotOfTotalDebtRedist: 0n,
          interestRate: 5n * 10n ** 16n,
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
          openedAt: 1n,
          openedAtBlock: 1n,
          openedTxHash: "0xopen",
          closedAt: undefined,
          closedAtBlock: undefined,
          closedTxHash: undefined,
          lastUserActionAt: 1n,
          lastUpdatedAt: 2n,
          lastUpdatedBlock: 2n,
        },
      ],
    ]);
    const pendingBatchOps = new Set([pendingId]);
    const pendingBatchedUpdates = new Set([pendingId]);
    const brackets = new Map<string, Record<string, unknown>>();
    const context = {
      Trove: {
        get: async (id: string) => troves.get(id),
        set: (entity: Record<string, unknown>) =>
          troves.set(String(entity.id), entity),
      },
      BorrowerInfo: { get: async () => undefined, set: () => undefined },
      InterestRateBracket: {
        get: async (id: string) => brackets.get(id),
        set: (entity: Record<string, unknown>) =>
          brackets.set(String(entity.id), entity),
      },
      PendingBatchMembershipOperation: {
        get: async (id: string) =>
          pendingBatchOps.has(id)
            ? {
                id,
                collateralId,
                txHash,
                troveId,
                operation: OP.REMOVE_FROM_BATCH,
                annualInterestRate: 5n * 10n ** 16n,
                interestBatchId: batchId,
                timestamp: 2n,
                blockNumber: 2n,
              }
            : undefined,
        deleteUnsafe: (id: string) => pendingBatchOps.delete(id),
      },
      PendingBatchedTroveUpdate: {
        deleteUnsafe: (id: string) => pendingBatchedUpdates.delete(id),
      },
      PendingRedemption: {
        get: async () => undefined,
        deleteUnsafe: () => undefined,
      },
    };

    await replayBatchedTroveUpdate(context as never, {
      chainId,
      txHash,
      collateralId,
      batchId,
      pending: {
        id: pendingId,
        troveId,
        batchDebtShares: 10n,
        coll: 4_900n,
        stake: 4_900n,
        snapshotOfTotalCollRedist: 0n,
        snapshotOfTotalDebtRedist: 0n,
      },
      blockNumber: 3n,
      blockTimestamp: 3n,
      batchDebt: 900n,
      totalDebtShares: 10n,
      annualInterestRate: 4n * 10n ** 16n,
      price: null,
      collateral: { minDebt: 1n, systemParamsLoaded: true },
      instance: {
        ...makeLiquityInstance(collateralId, chainId, 1n),
        activeTroveCount: 1,
        systemDebt: 1_100n,
      },
    });

    const updated = troves.get(`${collateralId}-${troveId}`);
    assert.equal(updated?.interestBatchId, undefined);
    assert.equal(updated?.batchDebtShares, 0n);
    assert.equal(updated?.interestRate, 5n * 10n ** 16n);
    assert.equal(pendingBatchOps.has(pendingId), false);
    assert.equal(brackets.size, 0);
  });

  it("clears pending redemption markers after batched trove replay", async () => {
    const chainId = 42220;
    const txHash =
      "0x00000000000000000000000000000000000000000000000000000000000000ab";
    const collateralId = "42220-0xabc";
    const troveId = "0x1";
    const pendingId = pendingTroveKey(chainId, txHash, collateralId, troveId);
    const batchId = `${collateralId}-0xbatch`;
    const troves = new Map<string, Record<string, unknown>>([
      [
        `${collateralId}-${troveId}`,
        {
          id: `${collateralId}-${troveId}`,
          chainId,
          collateralId,
          troveId,
          owner: "0x0000000000000000000000000000000000000000",
          previousOwner: "0x0000000000000000000000000000000000000000",
          status: TROVE_STATUS.ACTIVE,
          debt: 1_000n,
          coll: 5_000n,
          stake: 5_000n,
          snapshotOfTotalCollRedist: 0n,
          snapshotOfTotalDebtRedist: 0n,
          interestRate: 0n,
          interestBatchId: batchId,
          batchDebtShares: 10n,
          icrBps: 0,
          liquidatedColl: undefined,
          liquidatedDebt: undefined,
          collSurplus: undefined,
          priceAtLiquidation: undefined,
          redemptionCount: 1,
          redeemedColl: 100n,
          redeemedDebt: 100n,
          redemptionFeePaidCum: 0n,
          openedAt: 1n,
          openedAtBlock: 1n,
          openedTxHash: "0xopen",
          closedAt: undefined,
          closedAtBlock: undefined,
          closedTxHash: undefined,
          lastUserActionAt: 1n,
          lastUpdatedAt: 1n,
          lastUpdatedBlock: 1n,
        },
      ],
    ]);
    const pendingRedemptions = new Set([pendingId]);
    const pendingBatchedUpdates = new Set([pendingId]);
    const context = {
      Trove: {
        get: async (id: string) => troves.get(id),
        set: (entity: Record<string, unknown>) =>
          troves.set(String(entity.id), entity),
      },
      BorrowerInfo: { get: async () => undefined, set: () => undefined },
      InterestRateBracket: { get: async () => undefined, set: () => undefined },
      PendingBatchMembershipOperation: {
        get: async () => undefined,
        deleteUnsafe: () => undefined,
      },
      PendingBatchedTroveUpdate: {
        deleteUnsafe: (id: string) => pendingBatchedUpdates.delete(id),
      },
      PendingRedemption: {
        get: async (id: string) =>
          pendingRedemptions.has(id) ? { id } : undefined,
        deleteUnsafe: (id: string) => pendingRedemptions.delete(id),
      },
    };

    await replayBatchedTroveUpdate(context as never, {
      chainId,
      txHash,
      collateralId,
      batchId,
      pending: {
        id: pendingId,
        troveId,
        batchDebtShares: 10n,
        coll: 4_800n,
        stake: 4_800n,
        snapshotOfTotalCollRedist: 0n,
        snapshotOfTotalDebtRedist: 0n,
      },
      blockNumber: 2n,
      blockTimestamp: 2n,
      batchDebt: 900n,
      totalDebtShares: 10n,
      annualInterestRate: 4n * 10n ** 16n,
      price: null,
      collateral: { minDebt: 1n, systemParamsLoaded: true },
      instance: {
        ...makeLiquityInstance(collateralId, chainId, 1n),
        activeTroveCount: 1,
        systemDebt: 1_000n,
      },
    });

    assert.equal(pendingRedemptions.has(pendingId), false);
    assert.equal(pendingBatchedUpdates.has(pendingId), false);
    assert.equal(troves.get(`${collateralId}-${troveId}`)?.debt, 900n);
  });
});
