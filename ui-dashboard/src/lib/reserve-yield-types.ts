export const RESERVE_API_URL =
  "https://mento-analytics-api-12390052758.us-central1.run.app/api/v2/reserve";
export const FEDFUNDS_CSV_URL =
  "https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS";

export const RESERVE_YIELD_EXPENSE_BPS = 15;
export const RESERVE_YIELD_REVENUE_SHARE_BPS = 8_000;
export const FORECASTABLE_AUSD_SYMBOL = "AUSD";
export const FORECASTABLE_SUSDS_SYMBOL = "SUSDS";
export const FORECASTABLE_STETH_SYMBOL = "STETH";

export type FetchImpl = typeof fetch;

export type ReserveYieldHolding = {
  id: string;
  assetSymbol: string;
  chain: string;
  sourceType: string;
  sourceLabel: string;
  identifier: string | null;
  custodianType: string | null;
  balance: number;
  principalUsd: number;
  earnedYieldUsd: number | null;
  apyPercent: number | null;
  yieldModel: string;
  dailyRunRateUsd: number | null;
  next30dUsd: number | null;
  next365dUsd: number | null;
  annualRunRateUsd: number | null;
};

export type ReserveYieldResponse = {
  principalUsd: number | null;
  forecastPrincipalUsd: number | null;
  earnedYieldUsd: number | null;
  realizedYieldUsd: number | null;
  unrealizedYieldUsd: number | null;
  earnedYieldAsOf: string | null;
  holdings: ReserveYieldHolding[];
  holdingsAsOf: string | null;
  grossApyPercent: number | null;
  fedfundsAsOf: string | null;
  expenseBps: typeof RESERVE_YIELD_EXPENSE_BPS;
  revenueShareBps: typeof RESERVE_YIELD_REVENUE_SHARE_BPS;
  netMentoApyPercent: number | null;
  skySavingsRateApyPercent: number | null;
  skySavingsRateSource: SkySavingsRateSource | null;
  dailyRunRateUsd: number | null;
  next30dUsd: number | null;
  next365dUsd: number | null;
  annualRunRateUsd: number | null;
  forecastUnavailableSymbols: string[];
  holdingsError: string | null;
  rateError: string | null;
  earnedYieldError: string | null;
};

export type ReserveYieldExtraction = {
  holdings: ReserveYieldHolding[];
  malformedCount: number;
  trackedAssetCount: number;
  susdsAssetCount: number;
};

export type FredObservation = {
  date: string;
  grossApyPercent: number;
};

export type SkySavingsRateSource =
  | "onchain-susds-ssr"
  | "blockanalitica-overall";

export type SkySavingsRateObservation = {
  apyPercent: number;
  source: SkySavingsRateSource;
};

export type ForecastApyBySymbol = {
  ausdNetMentoApyPercent: number | null;
  susdsApyPercent: number | null;
  susdsApySource: SkySavingsRateSource | null;
  stethApyPercent: number | null;
};

export type ForecastTotals = {
  modeledHoldings: ReserveYieldHolding[];
  forecastPrincipalUsd: number | null;
  dailyRunRateUsd: number | null;
  next30dUsd: number | null;
  next365dUsd: number | null;
  annualRunRateUsd: number | null;
  forecastUnavailableSymbols: string[];
};

export type SusdsYieldLedger = {
  earnedYieldUsd: number;
  realizedYieldUsd: number;
  unrealizedYieldUsd: number;
  costBasisUsd: number;
  currentValueUsd: number;
  asOf: string | null;
};

export type SusdsYieldLedgerResult = {
  ledger: SusdsYieldLedger | null;
  error: string | null;
};

export type SusdsYieldState = {
  holdings: ReserveYieldHolding[];
  earnedYieldUsd: number | null;
  realizedYieldUsd: number | null;
  unrealizedYieldUsd: number | null;
  earnedYieldAsOf: string | null;
  earnedYieldError: string | null;
};

export type ReserveHoldingsState = {
  holdings: ReserveYieldHolding[];
  principalUsd: number | null;
  holdingsAsOf: string | null;
  holdingsError: string | null;
  hasCurrentSusdsAsset: boolean;
};
