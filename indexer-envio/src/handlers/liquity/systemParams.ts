import type { LiquityCollateral, LiquityInstance, Trove } from "envio";
import { createEffect, S } from "envio";
import systemParamsAbi from "../../../abis/liquity/SystemParams.json" with { type: "json" };
import {
  getFallbackRpcClient,
  getRpcClient,
  readContractWithBlockFallback,
} from "../../rpc.js";
import { trackEffectExecution } from "../../performance.js";
import type { LiquityMarketConfig } from "./config.js";
import { makeCollateralId } from "./config.js";
import { makeLiquityCollateral } from "./bootstrap.js";
import { reclassifyTrovesForLoadedParams } from "./troves.js";

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
type ParamValues = Record<ParamGetter, bigint>;

const systemParamsShape = S.schema({
  MCR: S.bigint,
  CCR: S.bigint,
  SCR: S.bigint,
  BCR: S.bigint,
  MIN_DEBT: S.bigint,
  MIN_BOLD_IN_SP: S.bigint,
  MIN_BOLD_AFTER_REBALANCE: S.bigint,
  MIN_ANNUAL_INTEREST_RATE: S.bigint,
  SP_YIELD_SPLIT: S.bigint,
  LIQUIDATION_PENALTY_SP: S.bigint,
  LIQUIDATION_PENALTY_REDISTRIBUTION: S.bigint,
  ETH_GAS_COMPENSATION: S.bigint,
  REDEMPTION_FEE_FLOOR: S.bigint,
  REDEMPTION_BETA: S.bigint,
  REDEMPTION_MINUTE_DECAY_FACTOR: S.bigint,
  INITIAL_BASE_RATE: S.bigint,
});

const liquitySystemParamsEffect = createEffect(
  {
    name: "liquitySystemParams",
    input: { chainId: S.int32, systemParams: S.string },
    output: S.nullable(systemParamsShape),
    rateLimit: { calls: 5, per: "second" },
    cache: true,
  },
  async ({ input, context }) => {
    const values = await trackEffectExecution("liquitySystemParams", async () =>
      loadSystemParamValues(input.chainId, input.systemParams),
    );
    if (values === undefined) {
      context.cache = false;
      return null;
    }
    return values;
  },
);

type SystemParamsContext = {
  effect: (
    effect: typeof liquitySystemParamsEffect,
    input: { chainId: number; systemParams: string },
  ) => Promise<ParamValues | null>;
  LiquityCollateral: {
    get: (id: string) => Promise<LiquityCollateral | undefined>;
    set: (entity: LiquityCollateral) => void;
  };
  LiquityInstance: {
    get: (id: string) => Promise<LiquityInstance | undefined>;
    set: (entity: LiquityInstance) => void;
  };
  Trove: {
    get: (id: string) => Promise<Trove | undefined>;
    set: (entity: Trove) => void;
    getWhere: (args: { collateralId: { _eq: string } }) => Promise<Trove[]>;
  };
};

async function readParam(
  chainId: number,
  systemParams: string,
  getter: ParamGetter,
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
      undefined,
      getFallbackRpcClient(chainId),
    );
    if (usedLatestFallback || typeof result !== "bigint") return undefined;
    return result;
  } catch {
    return undefined;
  }
}

async function loadSystemParamValues(
  chainId: number,
  systemParams: string,
): Promise<ParamValues | undefined> {
  const params = {} as ParamValues;
  for (const getter of PARAM_GETTERS) {
    const value = await readParam(chainId, systemParams, getter);
    if (value === undefined) return undefined;
    params[getter] = value;
  }
  return params;
}

export async function preloadSystemParams(
  context: SystemParamsContext,
  market: LiquityMarketConfig,
): Promise<ParamValues | null> {
  const values = await context.effect(liquitySystemParamsEffect, {
    chainId: market.chainId,
    systemParams: market.systemParams,
  });

  const id = makeCollateralId(market);
  const existing = await context.LiquityCollateral.get(id);
  if (existing?.systemParamsLoaded !== true) {
    await Promise.all([
      context.LiquityInstance.get(id),
      context.Trove.getWhere({ collateralId: { _eq: id } }),
    ]);
  }
  return values;
}

async function getOrLoadSystemParamValues(
  context: SystemParamsContext,
  market: LiquityMarketConfig,
): Promise<ParamValues | undefined> {
  return (
    (await context.effect(liquitySystemParamsEffect, {
      chainId: market.chainId,
      systemParams: market.systemParams,
    })) ?? undefined
  );
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

  const values = await getOrLoadSystemParamValues(context, market);
  if (values === undefined) {
    context.LiquityCollateral.set(existing);
    return existing;
  }

  const mcr = values.MCR;
  const ccr = values.CCR;
  const scr = values.SCR;
  const bcr = values.BCR;
  const minDebt = values.MIN_DEBT;
  const minBoldInSp = values.MIN_BOLD_IN_SP;
  const minBoldAfterRebalance = values.MIN_BOLD_AFTER_REBALANCE;
  const minAnnualInterestRate = values.MIN_ANNUAL_INTEREST_RATE;
  const spYieldSplit = values.SP_YIELD_SPLIT;
  const liquidationPenaltySp = values.LIQUIDATION_PENALTY_SP;
  const liquidationPenaltyRedistribution =
    values.LIQUIDATION_PENALTY_REDISTRIBUTION;
  const ethGasCompensation = values.ETH_GAS_COMPENSATION;
  const redemptionFeeFloor = values.REDEMPTION_FEE_FLOOR;
  const redemptionBeta = values.REDEMPTION_BETA;
  const redemptionMinuteDecayFactor = values.REDEMPTION_MINUTE_DECAY_FACTOR;
  const initialBaseRate = values.INITIAL_BASE_RATE;

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
  await reclassifyTrovesForLoadedParams(context, id, minDebt, minBoldInSp);
  return next;
}
