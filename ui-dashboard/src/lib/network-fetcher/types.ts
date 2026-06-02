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
  PoolDailyFeeSnapshot,
  PoolSnapshotWindow,
  TradingLimit,
} from "@/lib/types";
import type { SnapshotWindows } from "@/lib/volume";

export type { SnapshotWindows, TimeRange } from "@/lib/volume";

/**
 * Plain, RSC-serializable error shape. `NetworkData` crosses the Server →
 * Client boundary as `initialNetworkData`, and React's Flight serializer
 * opaques `Error` instances to a generic "An error occurred in the Server
 * Components render…" placeholder in production builds. Carrying the failure
 * as a plain `{ message }` object keeps the real cause renderable in
 * `<ErrorBox message={…}>` on the client. Convert at the fetch boundary
 * (see `toErrorShape` in `./fetch`) — never store an `Error` instance on a
 * field that ships to the client.
 */
export type SerializableError = { message: string };

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
  /**
   * Full-history daily rollup of legacy v2 (Broker → BiPoolManager) volume,
   * filtered to `routedViaV3Router=false` so VirtualPool sibling rows aren't
   * double-counted against v3. Empty on chains without a Broker (Monad).
   */
  brokerSnapshotsAllDaily: BrokerDailySnapshotRow[];
  /** True when the broker pagination loop hit its safety cap. */
  brokerSnapshotsAllDailyTruncated: boolean;
  tradingLimits: TradingLimit[];
  olsPoolIds: Set<string>;
  /**
   * Pool IDs classified as CDP or Reserve for global strategy badges. CDP
   * badges are Celo-only and come from indexed CdpPool rows. Indexed Celo
   * intentionally withholds Reserve without a positive indexed Reserve
   * source; non-Celo fallback probes only contribute Reserve classifications.
   */
  cdpPoolIds: Set<string>;
  reservePoolIds: Set<string>;
  /**
   * Strategy-classification query/probe failures. This does not blank the
   * table, but it marks SSR payloads degraded so SWR retries immediately
   * instead of pinning missing badges until the next poll.
   */
  strategyError: SerializableError | null;
  fees: ProtocolFeeSummary | null;
  /**
   * Daily-rollup fee snapshots, paginated to all-time history. Source of truth
   * for ALL fee surfaces on /revenue: KPI tile, chart, leaderboard.
   */
  feeSnapshots: PoolDailyFeeSnapshot[];
  /**
   * Snapshot fetch failures (paginated `PoolDailyFeeSnapshot` rejected or
   * surfaced a mid-pagination error). Blanks all fee surfaces (tile, chart,
   * leaderboard) since they all read from snapshots.
   */
  feeSnapshotsError: SerializableError | null;
  /**
   * True when paginated snapshot fetch hit `SNAPSHOT_MAX_PAGES` without
   * exhausting the result set — `feeSnapshots` carries the most-recent rows
   * we did fetch, but oldest history was dropped. All-time totals are a
   * lower bound; UI marks them approximate.
   */
  feeSnapshotsTruncated: boolean;
  /**
   * Lowercase-address → token-pair map for slim hooks that don't fetch the
   * full `pools` payload. Empty by default; consumers with a populated
   * `pools` array should derive labels from that instead.
   */
  poolLabels: Map<string, PoolLabel>;
  uniqueLpAddresses: string[] | null;
  rates: OracleRateMap;
  error: SerializableError | null;
  /**
   * Failure of the oracle rates query for this network. With no rates,
   * any non-USD-pegged token (FX) silently mis-prices to "unpriced", so
   * every fee surface — KPI tile, chart, leaderboard — must gate on this.
   */
  ratesError: SerializableError | null;
  /**
   * Per-window snapshot errors. A window only gets an error when the
   * pagination failure / truncation actually affects that window — i.e.,
   * we didn't fetch rows going back as far as the window's lower bound.
   */
  snapshotsError: SerializableError | null;
  snapshots7dError: SerializableError | null;
  snapshots30dError: SerializableError | null;
  /** Error on the paginated all-history daily fetch. */
  snapshotsAllDailyError: SerializableError | null;
  /** Error on the paginated all-history daily Broker rollup fetch. */
  brokerSnapshotsAllDailyError: SerializableError | null;
  lpError: SerializableError | null;
};

/**
 * Legacy v2 volume row from `BrokerDailySnapshot`. Already filtered server-
 * side to `routedViaV3Router=false` — the rows in this array are pure v2
 * (Broker-direct or v2 MentoRouter), no router-driven sibling double-count.
 */
export type BrokerDailySnapshotRow = {
  /** Canonical row key — used by the paginated fetcher's dedup set. Schema
   *  format is `{chainId}-{provider}-{router|direct}-{day}`. */
  id: string;
  /** UTC-day bucket as a unix-seconds string. */
  timestamp: string;
  /** 18-decimal "USD-wei" — divide by 1e18 to get USD. */
  volumeUsdWei: string;
  swapCount: number;
};

export type PoolLabel = Pick<Pool, "id" | "token0" | "token1" | "source">;

export type PaginatedPageResult<T> = {
  rows: T[];
  truncated: boolean;
  error: Error | null;
};

export type SnapshotPageResult = PaginatedPageResult<PoolSnapshotWindow>;
