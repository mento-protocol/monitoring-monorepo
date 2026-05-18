import rawConfig from "../../../config/liquity.json" with { type: "json" };
import { asAddress } from "../../helpers.js";

export type LiquityMarketConfig = {
  chainId: number;
  collIndex: number;
  symbol: string;
  debtToken: string;
  collToken: string;
  collateralRegistry: string;
  troveManager: string;
  stabilityPool: string;
  borrowerOperations: string;
  troveNFT: string;
  sortedTroves: string;
  activePool: string;
  defaultPool: string;
  collSurplusPool: string;
  addressesRegistry: string;
  systemParams: string;
  cdpLiquidityStrategy: string;
  slug: string;
};

type LiquityConfig = {
  markets: LiquityMarketConfig[];
  shared: {
    reserveTroveFactory: string;
    oracleAdapterCollateral: string;
  };
  poolFallbacks: Record<string, string>;
};

const config = rawConfig as LiquityConfig;

const normalizeMarket = (market: LiquityMarketConfig): LiquityMarketConfig => ({
  ...market,
  debtToken: asAddress(market.debtToken),
  collToken: asAddress(market.collToken),
  collateralRegistry: asAddress(market.collateralRegistry),
  troveManager: asAddress(market.troveManager),
  stabilityPool: asAddress(market.stabilityPool),
  borrowerOperations: asAddress(market.borrowerOperations),
  troveNFT: asAddress(market.troveNFT),
  sortedTroves: asAddress(market.sortedTroves),
  activePool: asAddress(market.activePool),
  defaultPool: asAddress(market.defaultPool),
  collSurplusPool: asAddress(market.collSurplusPool),
  addressesRegistry: asAddress(market.addressesRegistry),
  systemParams: asAddress(market.systemParams),
  cdpLiquidityStrategy: asAddress(market.cdpLiquidityStrategy),
});

export const LIQUITY_MARKETS = config.markets.map(normalizeMarket);

export const makeCollateralId = (market: {
  chainId: number;
  troveManager: string;
}): string => `${market.chainId}-${asAddress(market.troveManager)}`;

export const marketByCollateralId = new Map(
  LIQUITY_MARKETS.map((market) => [makeCollateralId(market), market]),
);

export const marketByDebtToken = new Map(
  LIQUITY_MARKETS.map((market) => [
    `${market.chainId}-${market.debtToken}`,
    market,
  ]),
);

export const marketByAddressesRegistry = new Map(
  LIQUITY_MARKETS.map((market) => [
    `${market.chainId}-${market.addressesRegistry}`,
    market,
  ]),
);

const addressRoles = [
  "collateralRegistry",
  "troveManager",
  "stabilityPool",
  "borrowerOperations",
  "troveNFT",
  "activePool",
  "defaultPool",
] as const;

export const marketByContractAddress = new Map<string, LiquityMarketConfig>();

for (const market of LIQUITY_MARKETS) {
  for (const role of addressRoles) {
    marketByContractAddress.set(`${market.chainId}-${market[role]}`, market);
  }
}

export const findLiquityMarketByEventSource = (
  chainId: number,
  srcAddress: string,
): LiquityMarketConfig | undefined =>
  marketByContractAddress.get(`${chainId}-${asAddress(srcAddress)}`);

export const findLiquityMarketByDebtToken = (
  chainId: number,
  debtToken: string,
): LiquityMarketConfig | undefined =>
  marketByDebtToken.get(`${chainId}-${asAddress(debtToken)}`);

export const findLiquityMarketByAddressesRegistry = (
  chainId: number,
  addressesRegistry: string,
): LiquityMarketConfig | undefined =>
  marketByAddressesRegistry.get(`${chainId}-${asAddress(addressesRegistry)}`);

export const findCollateralIdByPoolFallback = (
  chainId: number,
  poolAddress: string,
): string | undefined => {
  const fallback = config.poolFallbacks[`${chainId}-${asAddress(poolAddress)}`];
  return fallback === undefined ? undefined : fallback;
};
