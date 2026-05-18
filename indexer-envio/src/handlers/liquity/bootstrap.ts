import type { LiquityCollateral, LiquityInstance } from "envio";
import { dayBucket, hourBucket } from "../../helpers.js";
import {
  LIQUITY_MARKETS,
  type LiquityMarketConfig,
  makeCollateralId,
} from "./config.js";

const ZERO_PARAMS = {
  mcrBps: -1,
  ccrBps: -1,
  scrBps: -1,
  bcrBps: -1,
  minDebt: 0n,
  minBoldInSp: 0n,
  minBoldAfterRebalance: 0n,
  minAnnualInterestRate: 0n,
  spYieldSplitBps: -1,
  liquidationPenaltySpBps: -1,
  liquidationPenaltyRedistributionBps: -1,
  ethGasCompensation: 0n,
  redemptionFeeFloorBps: -1,
  redemptionBeta: 0n,
  redemptionMinuteDecayFactor: 0n,
  initialBaseRateBps: -1,
};

export type LiquityBootstrapContext = {
  LiquityCollateral: {
    get: (id: string) => Promise<LiquityCollateral | undefined>;
    set: (entity: LiquityCollateral) => void;
  };
  LiquityInstance: {
    get: (id: string) => Promise<LiquityInstance | undefined>;
    set: (entity: LiquityInstance) => void;
  };
};

export const makeLiquityCollateral = (
  market: LiquityMarketConfig,
  blockNumber: bigint,
  blockTimestamp: bigint,
): LiquityCollateral => ({
  id: makeCollateralId(market),
  chainId: market.chainId,
  collIndex: market.collIndex,
  symbol: market.symbol,
  debtToken: market.debtToken,
  collToken: market.collToken,
  collateralRegistry: market.collateralRegistry,
  troveManager: market.troveManager,
  stabilityPool: market.stabilityPool,
  borrowerOperations: market.borrowerOperations,
  troveNFT: market.troveNFT,
  sortedTroves: market.sortedTroves,
  activePool: market.activePool,
  defaultPool: market.defaultPool,
  collSurplusPool: market.collSurplusPool,
  addressesRegistry: market.addressesRegistry,
  systemParams: market.systemParams,
  ...ZERO_PARAMS,
  systemParamsLoaded: false,
  createdAtBlock: blockNumber,
  createdAtTimestamp: blockTimestamp,
});

export const makeLiquityInstance = (
  collateralId: string,
  chainId: number,
  timestamp: bigint,
): LiquityInstance => ({
  id: collateralId,
  collateralId,
  chainId,
  activePoolDebt: 0n,
  defaultPoolDebt: 0n,
  activePoolColl: 0n,
  defaultPoolColl: 0n,
  systemColl: 0n,
  systemDebt: 0n,
  tcrBps: -1,
  spDeposits: 0n,
  spColl: 0n,
  spHeadroom: -1n,
  baseRate: 0n,
  lastFeeOpTime: 0n,
  currentRedemptionRateBps: -1,
  activeTroveCount: 0,
  icrP1Bps: -1,
  icrP5Bps: -1,
  icrP50Bps: -1,
  icrFracBelowMcrBps: -1,
  liqCountCum: 0,
  liqDebtOffsetCum: 0n,
  liqDebtRedistributedCum: 0n,
  liqCollSentToSpCum: 0n,
  liqCollRedistributedCum: 0n,
  latestTotalCollRedist: 0n,
  latestTotalDebtRedist: 0n,
  redemptionCountCum: 0,
  redemptionDebtCum: 0n,
  redemptionFeeCum: 0n,
  borrowingFeeCum: 0n,
  spRebalanceCount: 0,
  spRebalanceCollInCum: 0n,
  spRebalanceStableOutCum: 0n,
  shortfallSubsidyCum: 0n,
  troveOpenedCountBucket: 0,
  troveClosedCountBucket: 0,
  liqCountBucket: 0,
  liqDebtOffsetBucket: 0n,
  redemptionCountBucket: 0,
  redemptionDebtBucket: 0n,
  spRebalanceCountBucket: 0,
  shortfallSubsidyBucket: 0n,
  currentHourBucket: hourBucket(timestamp),
  troveOpenedCountDayBucket: 0,
  troveClosedCountDayBucket: 0,
  liqCountDayBucket: 0,
  liqDebtOffsetDayBucket: 0n,
  redemptionCountDayBucket: 0,
  redemptionDebtDayBucket: 0n,
  spRebalanceCountDayBucket: 0,
  shortfallSubsidyDayBucket: 0n,
  currentDayBucket: dayBucket(timestamp),
  isShutDown: false,
  shutDownAt: undefined,
  shutDownTcrBps: undefined,
  lastEventBlock: 0n,
  lastEventTimestamp: 0n,
});

export async function bootstrapCollaterals(
  context: LiquityBootstrapContext,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  for (const market of LIQUITY_MARKETS) {
    const id = makeCollateralId(market);
    const existingCollateral = await context.LiquityCollateral.get(id);
    context.LiquityCollateral.set(
      existingCollateral ??
        makeLiquityCollateral(market, blockNumber, blockTimestamp),
    );

    const existingInstance = await context.LiquityInstance.get(id);
    context.LiquityInstance.set(
      existingInstance ??
        makeLiquityInstance(id, market.chainId, blockTimestamp),
    );
  }
}

export async function getOrCreateLiquityInstance(
  context: LiquityBootstrapContext,
  market: LiquityMarketConfig,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<LiquityInstance> {
  await bootstrapCollaterals(context, blockNumber, blockTimestamp);
  const id = makeCollateralId(market);
  const existing = await context.LiquityInstance.get(id);
  return existing ?? makeLiquityInstance(id, market.chainId, blockTimestamp);
}
