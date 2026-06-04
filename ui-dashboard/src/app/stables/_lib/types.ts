import type { StableSupplySource, StableSupplyChangeKind } from "@/lib/stables";

// Raw row shape returned by STABLES_DAILY_SNAPSHOTS and the normalized
// current-state supply feed.
// `totalSupply` / `dailyMintAmount` / `dailyBurnAmount` are token-native wei
// serialized as strings by Hasura (numeric → string in JSON to preserve
// 256-bit precision); parse to bigint via `BigInt(...)` at consumption.
export type StableSupplyDailySnapshot = {
  id: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  source: StableSupplySource;
  tokenDecimals: number;
  timestamp: string;
  totalSupply: string;
  dailyMintAmount: string;
  dailyBurnAmount: string;
};

export type StableTokenCustodyDailySnapshot = {
  id: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  source: StableSupplySource;
  tokenDecimals: number;
  managerAddress: string;
  timestamp: string;
  lockedSupply: string;
  dailyLockedAmount: string;
  dailyUnlockedAmount: string;
};

export type StableSupplyChangeEvent = {
  id: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  source: StableSupplySource;
  kind: StableSupplyChangeKind;
  counterparty: string;
  caller: string;
  txTo: string;
  // Optional until every deployed indexer endpoint exposes this marker.
  isSystemCaller?: boolean;
  amount: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

// Per-token aggregate computed by `rollupByToken` — feeds the sparkline grid,
// KPI tiles, and hero chart.
export type TokenAgg = {
  // Discriminator key: `{chainId}|{tokenAddress}|{source}`. The same Mento
  // token can exist on Celo and Monad, so chainId is part of the identity.
  key: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  source: StableSupplySource;
  tokenDecimals: number;
  // Most recent circulating supply after custody subtraction. Current-state
  // rows override sparse same-day daily snapshots for this headline.
  latestTotalSupply: bigint;
  latestLockedSupply: bigint;
  latestTimestamp: bigint;
  // Computed at rollup time over the active range. UI uses these directly
  // — no client-side aggregation in the render path.
  totalSupplyUsdLatest: number | null;
  change7dPct: number | null;
  netChange7d: bigint;
  netChange7dUsd: number | null;
};

// Range vocabulary — matches `@/lib/time-series` `RangeKey` exactly. Earlier
// PR2 pass-2 narrowed to `"7d" | "30d" | "all"` to catch the silently-
// wrong `90d` cutoff math, then `rangeStartSeconds` was updated to handle
// `90d` correctly (days-back = 89), so the narrow type is no longer
// needed. Keeping the union in sync with the lib type avoids the
// onRangeChange callback type mismatch when `TimeSeriesChartCard` (which
// types its callback against the lib's RangeKey) calls into the page.
export type RangeKey = "7d" | "30d" | "90d" | "all";
