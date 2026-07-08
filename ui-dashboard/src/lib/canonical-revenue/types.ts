import type {
  CdpBorrowingFeeSeriesPoint,
  CdpBorrowingRevenueMarket,
} from "@/lib/cdp-borrowing-revenue";
import type { NetworkData } from "@/lib/fetch-all-networks";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";

export type SusdsYieldDailySnapshotRow = {
  id: string;
  chainId: number;
  token: string;
  timestamp: string;
  currentShares: string;
  costBasisUsdWei: string;
  realizedYieldUsdWei: string;
  transferredOutYieldUsdWei: string;
  redeemedYieldUsdWei: string;
  currentValueUsdWei: string;
  unrealizedYieldUsdWei: string;
  totalEarnedYieldUsdWei: string;
  dailyEarnedYieldUsdWei: string;
  dailyRealizedYieldUsdWei: string;
  dailyUnrealizedYieldUsdWei: string;
  sharePriceUsdWei: string;
  sampledAtBlock: string;
  sampledAtTimestamp: string;
};

export type StethYieldDailySnapshotRow = {
  id: string;
  chainId: number;
  token: string;
  wallet: string;
  timestamp: string;
  balanceAmount: string;
  principalAmount: string;
  realizedYieldAmount: string;
  transferredOutYieldAmount: string;
  unrealizedYieldAmount: string;
  totalEarnedYieldAmount: string;
  dailyEarnedYieldAmount: string;
  dailyRealizedYieldAmount: string;
  dailyUnrealizedYieldAmount: string;
  sampledAtBlock: string;
  sampledAtTimestamp: string;
};

export type ReserveYieldDailySnapshotRow =
  | SusdsYieldDailySnapshotRow
  | StethYieldDailySnapshotRow;

type ActualRevenueValue = number | null;

export type ActualRevenueAvailability = {
  reserve: boolean;
  reserveStaleAfter: number | null;
  swap: boolean;
  cdp: boolean;
};

export type CanonicalRevenueDailyPoint = {
  timestamp: number;
  reserveYieldUsd: ActualRevenueValue;
  swapFeesUsd: ActualRevenueValue;
  cdpBorrowingUsd: ActualRevenueValue;
  totalRevenueUsd: ActualRevenueValue;
  availableRevenueUsd: number;
};

export type RevenuePeriodKey = "allTimeSinceV3" | "ytd" | "last30d" | "last7d";

export type RevenueForecastKey = "next7d" | "next30d" | "next365d";

export type CanonicalRevenuePeriod = {
  key: RevenuePeriodKey;
  title: string;
  subtitle: string;
  from: number;
  to: number;
  totalUsd: ActualRevenueValue;
  availableTotalUsd: number;
  reserveYieldUsd: ActualRevenueValue;
  swapFeesUsd: ActualRevenueValue;
  cdpBorrowingUsd: ActualRevenueValue;
  partialReasons: string[];
};

export type CanonicalRevenueForecast = {
  key: RevenueForecastKey;
  title: string;
  subtitle: string;
  days: number;
  totalUsd: number | null;
  reserveYieldUsd: number | null;
  swapFeesUsd: number | null;
  cdpBorrowingUsd: number | null;
  partialReasons: string[];
  assumption: string;
};

export type CanonicalRevenueStream = {
  key: "reserve" | "swap" | "cdp";
  title: string;
  actualUsd: ActualRevenueValue;
  forecast30dUsd: number | null;
  forecast365dUsd: number | null;
  subtitle: string;
  actualPartialReasons: string[];
  forecastPartialReasons: string[];
  partialReasons: string[];
};

export type CanonicalRevenueResult = {
  periods: Record<RevenuePeriodKey, CanonicalRevenuePeriod>;
  forecasts: Record<RevenueForecastKey, CanonicalRevenueForecast>;
  dailySeries: CanonicalRevenueDailyPoint[];
  streams: Record<CanonicalRevenueStream["key"], CanonicalRevenueStream>;
  partialReasons: string[];
};

export type BuildCanonicalRevenueArgs = {
  networkData: ReadonlyArray<NetworkData>;
  cdpDailySeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>;
  cdpMarkets: ReadonlyArray<CdpBorrowingRevenueMarket>;
  reserveYield: ReserveYieldResponse | null;
  reserveDailySnapshots: ReadonlyArray<ReserveYieldDailySnapshotRow>;
  reserveHistoryUnavailable?: boolean;
  reserveHistoryFailed?: boolean;
  reserveHistoryTruncated?: boolean;
  reserveHistoryUnpriced?: boolean;
  reserveYieldFailed?: boolean;
  swapFeesFailed?: boolean;
  swapFeesApproximate?: boolean;
  cdpDailySeriesFailed?: boolean;
  cdpInputsApproximate?: boolean;
  nowSeconds?: number;
};
