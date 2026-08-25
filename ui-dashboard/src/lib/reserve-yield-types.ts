export const RESERVE_API_URL =
  "https://mento-analytics-api-12390052758.us-central1.run.app/api/v2/reserve";
export const FEDFUNDS_CSV_URL =
  "https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS";

export const RESERVE_YIELD_EXPENSE_BPS = 15;
export const RESERVE_YIELD_REVENUE_SHARE_BPS = 8_000;
export const FORECASTABLE_AUSD_SYMBOL = "AUSD";
export const FORECASTABLE_SUSDS_SYMBOL = "SUSDS";
export const FORECASTABLE_STETH_SYMBOL = "STETH";
export const RESERVE_YIELD_ETHEREUM_CHAIN_ID = 1;
// Public Ethereum contract addresses are identifiers, not credentials.
// react-doctor-disable-next-line react-doctor/no-secrets-in-client-code
export const SUSDS_TOKEN_ADDRESS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
// Public Ethereum contract addresses are identifiers, not credentials.
// react-doctor-disable-next-line react-doctor/no-secrets-in-client-code
export const STETH_TOKEN_ADDRESS = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
export const TRACKED_STETH_WALLET_IDENTIFIERS = [
  "0xd0697f70e79476195b742d5afab14be50f98cc1e",
  "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1",
] as const;

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
  hasTokenBalance: boolean;
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
  /** sUSDS-only actuals. The aggregate earnedYieldUsd also includes stETH. */
  susdsEarnedYieldUsd?: number | null;
  /** sUSDS-only actuals timestamp. The aggregate timestamp also includes stETH. */
  susdsEarnedYieldAsOf?: string | null;
  /** True when the current sUSDS ledger signal cannot be established. */
  susdsYieldSignalUnavailable: boolean;
  /** True when current sUSDS exposure requires an indexed snapshot source. */
  susdsSnapshotSourceRequired: boolean;
  /** True when a current sUSDS source is outside indexed wallets or cannot be proven zero. */
  hasUnindexedSusdsHolding: boolean;
  /** True when current stETH exposure is positive or cannot be proven zero. */
  stethSnapshotSourceRequired?: boolean;
  /** True when a current stETH source is outside indexed wallets or cannot be proven zero. */
  hasIncompleteStethSourceCoverage?: boolean;
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
  /** True when the reserve request cannot establish current asset symbols. */
  reserveCurrentHoldingsClassificationFailed: boolean;
  holdingsError: string | null;
  rateError: string | null;
  earnedYieldError: string | null;
};

export type ReserveYieldExtraction = {
  holdings: ReserveYieldHolding[];
  malformedCount: number;
  reserveCurrentHoldingsClassificationFailed: boolean;
  trackedAssetCount: number;
  susdsAssetCount: number;
  susdsSnapshotSourceRequired: boolean;
  hasUnindexedSusdsHolding: boolean;
  stethAssetCount: number;
  stethSnapshotSourceRequired: boolean;
  hasIncompleteStethSourceCoverage: boolean;
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
  stethAprPercent: number | null;
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
  signalUnavailable: boolean;
};

export type StethYieldLedgerEntry = {
  wallet: string;
  earnedYieldAmount: bigint;
  realizedYieldAmount: bigint;
  unrealizedYieldAmount: bigint;
  asOf: string | null;
};

export type StethYieldLedgerResult = {
  entries: StethYieldLedgerEntry[];
  error: string | null;
};

export type StethYieldState = {
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
  reserveCurrentHoldingsClassificationFailed: boolean;
  hasCurrentSusdsAsset: boolean;
  susdsSnapshotSourceRequired: boolean;
  hasUnindexedSusdsHolding: boolean;
  hasCurrentStethAsset: boolean;
  stethSnapshotSourceRequired: boolean;
  hasIncompleteStethSourceCoverage: boolean;
};
