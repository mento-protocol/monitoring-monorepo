import type {
  StablesChangesQuery,
  StablesCurrentCustodyPerTokenQuery,
  StablesCurrentSupplyPerTokenQuery,
  StablesCustodyDailySnapshotsQuery,
  StablesDailySnapshotsQuery,
  StablesLatestCustodyPerTokenQuery,
  StablesLatestPerTokenQuery,
} from "@/lib/__generated__/graphql";
import type { StableSupplySource } from "@/lib/stables";

// Row shapes are generated from the stables GraphQL operations. The optional
// current-state discriminator is added after fetch normalization.
// `totalSupply` / `dailyMintAmount` / `dailyBurnAmount` are token-native wei
// serialized as strings by Hasura (numeric → string in JSON to preserve
// 256-bit precision); parse to bigint via `BigInt(...)` at consumption.
export type StableSupplyDailySnapshot = (
  | StablesDailySnapshotsQuery["StableSupplyDailySnapshot"][number]
  | StablesLatestPerTokenQuery["StableSupplyDailySnapshot"][number]
  | StablesCurrentSupplyPerTokenQuery["StableTokenSupply"][number]
) & {
  isCurrentState?: boolean;
};

export type StableTokenCustodyDailySnapshot =
  | StablesCustodyDailySnapshotsQuery["StableTokenCustodyDailySnapshot"][number]
  | StablesLatestCustodyPerTokenQuery["StableTokenCustodyDailySnapshot"][number]
  | StablesCurrentCustodyPerTokenQuery["StableTokenCustodyState"][number];

export type StableSupplyChangeEvent =
  StablesChangesQuery["StableSupplyChangeEvent"][number];

// Per-token aggregate computed by `rollupByToken` — feeds the sparkline grid,
// KPI tiles, and hero chart.
export type TokenAgg = {
  // Discriminator key: `{chainId}|{tokenAddress}|{source}`. The same Mento
  // token can exist on multiple chains, so chainId is part of the identity.
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
  // Net circulating-supply change in USD over the 24h / 7d / 30d rolling
  // windows, feeding the KPI-strip sub-rows. Each uses the same day-aligned
  // baseline math as `netChange7d` (see `buildTokenAgg`).
  netChange1dUsd: number | null;
  netChange7dUsd: number | null;
  netChange30dUsd: number | null;
};

// Range vocabulary — matches `@/lib/time-series` `RangeKey` exactly. Earlier
// PR2 pass-2 narrowed to `"7d" | "30d" | "all"` to catch the silently-
// wrong `90d` cutoff math, then `rangeStartSeconds` was updated to handle
// `90d` correctly (days-back = 89), so the narrow type is no longer
// needed. Keeping the union in sync with the lib type avoids the
// onRangeChange callback type mismatch when `TimeSeriesChartCard` (which
// types its callback against the lib's RangeKey) calls into the page.
export type RangeKey = "7d" | "30d" | "90d" | "all";
