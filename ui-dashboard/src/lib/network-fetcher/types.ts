// Type-only surface for the all-networks fetcher. Held in a separate module
// from `./fetch` so importers that only need the shape (e.g. slim hooks
// constructing `NetworkData[]`-shaped payloads) don't transitively pull
// `graphql-request`, `@sentry/nextjs`, and the rest of the runtime
// dependency graph. `SnapshotWindows` and `TimeRange` are re-exported from
// `@/lib/volume` so the barrel `@/lib/fetch-all-networks` exposes the full
// type surface from a single import path.

import type { Network } from "@/lib/networks";
import type { ProtocolFeeSummary } from "@/lib/protocol-fees";
import type { OracleRateMap } from "@/lib/tokens";
import type {
  Pool,
  PoolSnapshotWindow,
  ProtocolFeeTransfer,
  TradingLimit,
} from "@/lib/types";
import type { SnapshotWindows } from "@/lib/volume";

export type { SnapshotWindows, TimeRange } from "@/lib/volume";

export type NetworkData = {
  network: Network;
  snapshotWindows: SnapshotWindows;
  pools: Pool[];
  /**
   * Windowed snapshot arrays derived client-side by filtering
   * `snapshotsAllDaily` with UTC-midnight-anchored bounds. The source is the
   * daily rollup (one row per pool per UTC day), so each window contains
   * exactly 1/7/30 potential daily rows — no overcounting across UTC-day
   * boundaries. Intra-day precision is sacrificed; KPI tiles show UTC-day-
   * aligned totals.
   *
   * Per-window error fields below are only set when that window's coverage
   * is incomplete (i.e., we didn't paginate back far enough).
   */
  snapshots: PoolSnapshotWindow[];
  snapshots7d: PoolSnapshotWindow[];
  snapshots30d: PoolSnapshotWindow[];
  /**
   * Full-history daily rollup snapshots, one row per pool per UTC day.
   * Feeds both the TVL and Volume charts. At ~365 rows/pool/year a few pages
   * cover everything — this replaced the old hourly `snapshotsAll` fetch
   * whose ~8760 rows/pool/year × multi-chain fan-out routinely tripped the
   * Envio tier quota (429).
   */
  snapshotsAllDaily: PoolSnapshotWindow[];
  /** True when the daily pagination loop hit its safety cap. */
  snapshotsAllDailyTruncated: boolean;
  tradingLimits: TradingLimit[];
  olsPoolIds: Set<string>;
  /**
   * Pool IDs whose `rebalancerAddress` was positively probed as a CDP or
   * Reserve strategy (see `lib/strategy-detection.ts`). Pools whose probe
   * errored/timed out appear in NEITHER set — consumers must not default
   * absence to "Reserve", because doing so would surface a misleading
   * confident badge on every transport outage.
   */
  cdpPoolIds: Set<string>;
  reservePoolIds: Set<string>;
  fees: ProtocolFeeSummary | null;
  /** Raw fee transfer rows — kept for time-series bucketing on the revenue page. */
  feeTransfers: ProtocolFeeTransfer[];
  uniqueLpAddresses: string[] | null;
  rates: OracleRateMap;
  error: Error | null;
  feesError: Error | null;
  /**
   * Per-window snapshot errors. A window only gets an error when the
   * pagination failure / truncation actually affects that window — i.e.,
   * we didn't fetch rows going back as far as the window's lower bound.
   */
  snapshotsError: Error | null;
  snapshots7dError: Error | null;
  snapshots30dError: Error | null;
  /** Error on the paginated all-history daily fetch. */
  snapshotsAllDailyError: Error | null;
  lpError: Error | null;
};

export type SnapshotPageResult = {
  rows: PoolSnapshotWindow[];
  truncated: boolean;
  error: Error | null;
};
