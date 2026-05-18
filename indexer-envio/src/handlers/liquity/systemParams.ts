import type { LiquityCollateral } from "envio";
import systemParamsAbi from "../../../abis/liquity/SystemParams.json" with { type: "json" };
import {
  getFallbackRpcClient,
  getRpcClient,
  readContractWithBlockFallback,
} from "../../rpc.js";
import type { LiquityMarketConfig } from "./config.js";
import { makeCollateralId } from "./config.js";
import { makeLiquityCollateral } from "./bootstrap.js";

const D18 = 10n ** 18n;

const toBps = (value: bigint): number => Number((value * 10_000n) / D18);

const PARAM_GETTERS = [
  "MCR",
  "CCR",
  "SCR",
  "BCR",
  "MIN_DEBT",
  "MIN_BOLD_IN_SP",
  "MIN_BOLD_AFTER_REBALANCE",
  "MIN_ANNUAL_INTEREST_RATE",
  "SP_YIELD_SPLIT",
  "LIQUIDATION_PENALTY_SP",
  "LIQUIDATION_PENALTY_REDISTRIBUTION",
  "ETH_GAS_COMPENSATION",
  "REDEMPTION_FEE_FLOOR",
  "REDEMPTION_BETA",
  "REDEMPTION_MINUTE_DECAY_FACTOR",
  "INITIAL_BASE_RATE",
] as const;

type ParamGetter = (typeof PARAM_GETTERS)[number];

type SystemParamsContext = {
  LiquityCollateral: {
    get: (id: string) => Promise<LiquityCollateral | undefined>;
    set: (entity: LiquityCollateral) => void;
  };
};

async function readParam(
  chainId: number,
  systemParams: string,
  getter: ParamGetter,
  blockNumber: bigint,
): Promise<bigint | undefined> {
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: systemParams as `0x${string}`,
        abi: systemParamsAbi,
        functionName: getter,
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    if (usedLatestFallback || typeof result !== "bigint") return undefined;
    return result;
  } catch {
    return undefined;
  }
}

export async function getOrLoadSystemParams(
  context: SystemParamsContext,
  market: LiquityMarketConfig,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<LiquityCollateral | undefined> {
  const id = makeCollateralId(market);
  const existing =
    (await context.LiquityCollateral.get(id)) ??
    makeLiquityCollateral(market, blockNumber, blockTimestamp);
  if (existing.systemParamsLoaded) return existing;

  const values = await Promise.all(
    PARAM_GETTERS.map((getter) =>
      readParam(market.chainId, market.systemParams, getter, blockNumber),
    ),
  );
  if (values.some((value) => value === undefined)) {
    context.LiquityCollateral.set(existing);
    return existing;
  }

  const [
    mcr,
    ccr,
    scr,
    bcr,
    minDebt,
    minBoldInSp,
    minBoldAfterRebalance,
    minAnnualInterestRate,
    spYieldSplit,
    liquidationPenaltySp,
    liquidationPenaltyRedistribution,
    ethGasCompensation,
    redemptionFeeFloor,
    redemptionBeta,
    redemptionMinuteDecayFactor,
    initialBaseRate,
  ] = values as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];

  const next = {
    ...existing,
    mcrBps: toBps(mcr),
    ccrBps: toBps(ccr),
    scrBps: toBps(scr),
    bcrBps: toBps(bcr),
    minDebt,
    minBoldInSp,
    minBoldAfterRebalance,
    minAnnualInterestRate,
    spYieldSplitBps: toBps(spYieldSplit),
    liquidationPenaltySpBps: toBps(liquidationPenaltySp),
    liquidationPenaltyRedistributionBps: toBps(
      liquidationPenaltyRedistribution,
    ),
    ethGasCompensation,
    redemptionFeeFloorBps: toBps(redemptionFeeFloor),
    redemptionBeta,
    redemptionMinuteDecayFactor,
    initialBaseRateBps: toBps(initialBaseRate),
    systemParamsLoaded: true,
  };
  context.LiquityCollateral.set(next);
  return next;
}
