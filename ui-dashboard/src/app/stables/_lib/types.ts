import type { StableSupplySource, StableSupplyChangeKind } from "@/lib/stables";
import type { RangeKey as LibRangeKey } from "@/lib/time-series";

// Raw row shape returned by STABLES_DAILY_SNAPSHOTS / STABLES_LATEST_PER_TOKEN.
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

export type V2StableSupplyChangeEvent = {
  id: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  source: StableSupplySource;
  kind: StableSupplyChangeKind;
  counterparty: string;
  caller: string;
  txTo: string;
  isSystemCaller: boolean;
  amount: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

// Per-token aggregate computed by `rollupByToken` — feeds the sparkline grid,
// KPI tiles, and hero chart.
export type TokenAgg = {
  // Discriminator key: `{tokenAddress}|{source}` — V2 cUSD-USDm and V3 hub
  // USDm share the symbol "USDm" but live at distinct addresses, so a
  // (symbol-only) key would collapse them.
  key: string;
  tokenAddress: string;
  tokenSymbol: string;
  source: StableSupplySource;
  tokenDecimals: number;
  // Most recent snapshot row (may be N days old per sparse semantics).
  latestTotalSupply: bigint;
  latestTimestamp: bigint;
  // Computed at rollup time over the active range. UI uses these directly
  // — no client-side aggregation in the render path.
  totalSupplyUsdLatest: number | null;
  change7dPct: number | null;
  netChange7d: bigint;
  netChange7dUsd: number | null;
};

// Re-export the canonical RangeKey from `@/lib/time-series` so callers can
// import from a single place. `90d` is a valid range upstream — we currently
// only surface 7d/30d/all in the /stables UI but accept the wider type so
// the range pills can grow without a churn-only refactor.
export type RangeKey = LibRangeKey;
