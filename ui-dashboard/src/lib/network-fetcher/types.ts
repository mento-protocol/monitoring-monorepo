// Type-only surface for the all-networks fetcher. Held in a separate module
// from `./fetch` so importers that only need the shape (e.g. slim hooks
// constructing `NetworkData[]`-shaped payloads) don't transitively pull
// the transport, `@sentry/nextjs`, and the rest of the runtime
// dependency graph. `SnapshotWindows` and `TimeRange` are re-exported from
// `@/lib/volume` so the barrel `@/lib/fetch-all-networks` exposes the full
// type surface from a single import path.

import type { Network } from "@/lib/networks";
import type { ProtocolFeeSummary } from "@/lib/protocol-fees";
import type { OracleRateMap } from "@/lib/tokens";
import type {
  OlsPool,
  Pool,
  PoolDailyFeeSnapshot,
  PoolSnapshotWindow,
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
  /**
   * True while the visible `snapshotsAllDaily` rows are known to be only a
   * recent subset. The normal source fetch sets false; the Server Component
   * projection sets true, and a failed attempt to complete that bounded seed
   * keeps it true. This is distinct from `snapshotsAllDailyTruncated`: the
   * latter explains an upstream pagination safety outcome, while this flag is
   * the consumer contract that prevents presenting a subset as "All".
   * Incremental-cache seeding must keep the slice incomplete until a full
   * pagination succeeds.
   */
  snapshotsAllDailyCapped: boolean;
  /** True when the daily pagination loop hit its safety cap. */
  snapshotsAllDailyTruncated: boolean;
  /**
   * Full-history daily rollup of legacy v2 (Broker → BiPoolManager) volume,
   * filtered to `routedViaV3Router=false` so VirtualPool sibling rows aren't
   * double-counted against v3. Empty on chains without a Broker (Monad).
   */
  brokerSnapshotsAllDaily: BrokerDailySnapshotRow[];
  /**
   * True while the visible Broker daily rows are known to be incomplete: a
   * recent Server Component subset, a failed first page, or partial/truncated
   * pagination. Absence is equivalent to false for legacy fixtures. Together
   * with `snapshotsAllDailyCapped`, this prevents the volume chart from
   * presenting incomplete data as complete "All" history.
   */
  brokerSnapshotsAllDailyCapped?: boolean | undefined;
  /** True when the broker pagination loop hit its safety cap. */
  brokerSnapshotsAllDailyTruncated: boolean;
  olsPoolIds: Set<string>;
  /**
   * Pool IDs classified as CDP or Reserve for global strategy badges. The
   * active PoolLiquidityStrategy registry is authoritative and can classify
   * multiple simultaneous kinds for one pool. Legacy CdpPool, known-contract,
   * and RPC sources are used only while the registry schema is unavailable.
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
   * for ALL fee surfaces on /revenue: KPI tile, chart, table.
   */
  feeSnapshots: PoolDailyFeeSnapshot[];
  /**
   * Snapshot fetch failures (paginated `PoolDailyFeeSnapshot` rejected or
   * surfaced a mid-pagination error). Blanks all fee surfaces (tile, chart,
   * table) since they all read from snapshots.
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
  /**
   * True only when the Server Component projection deliberately removed the
   * cumulative address set. The homepage then reads the exact pre-aggregated
   * cross-chain count from its payload; a normal client fetch omits this flag
   * and restores address-level deduplication.
   */
  uniqueLpAddressesOmitted?: boolean | undefined;
  /** True when the LP address pagination loop hit its safety cap. */
  uniqueLpAddressesTruncated: boolean;
  rates: OracleRateMap;
  error: SerializableError | null;
  /** Failure of the lightweight 30s live-health overlay. Other dashboard data
   * remains usable, but Health badges stay at their last confirmed state. */
  liveHealthError?: SerializableError | null | undefined;
  /** True only when every cause represented by `liveHealthError` is covered
   * by the lightweight Pool poll. Deprecation and wrapper-quorum failures need
   * the slower fleet companions to recover and must remain visible. */
  liveHealthErrorClearsOnLivePoll?: boolean | undefined;
  /**
   * Failure of the oracle rates query for this network. With no rates,
   * any non-USD-pegged token (FX) silently mis-prices to "unpriced", so
   * every fee surface — KPI tile, chart, table — must gate on this.
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
 * Network data that is safe to seed into the `/` and `/pools` SSR fallback.
 *
 * The server computes the aggregated `fees` summary before serializing this
 * payload, then deliberately strips the raw fee-history rows and the three
 * redundant 1/7/30-day snapshot arrays. Keeping empty tuples in the public
 * type makes that projection part of the contract: the all-networks hook must
 * synchronously derive the window arrays from `snapshotsAllDaily` before the
 * fallback reaches consumers or incremental-cache seeding, while client
 * fallback consumers cannot treat the SSR seed as complete fee history.
 * `snapshotsAllDailyCapped` and `brokerSnapshotsAllDailyCapped` separately mark
 * whether canonical daily histories were shortened for transport; unlike fee
 * rows, that history is fetched on demand when a chart selects "All". The raw
 * cumulative LP-address set is also stripped; `uniqueLpAddressesOmitted`
 * routes the homepage to the payload-level exact aggregate instead.
 *
 * Growth audit invariant: every time/cumulative field in `NetworkData` is
 * bounded or aggregated here (`snapshotsAllDaily`, Broker history,
 * `feeSnapshots`, LP addresses). Remaining collections are bounded by the
 * configured network's current pool/token/strategy entity set.
 */
export type InitialNetworkData = Omit<
  NetworkData,
  | "feeSnapshots"
  | "snapshots"
  | "snapshots7d"
  | "snapshots30d"
  | "uniqueLpAddresses"
  | "uniqueLpAddressesOmitted"
> & {
  feeSnapshots: [];
  snapshots: [];
  snapshots7d: [];
  snapshots30d: [];
  uniqueLpAddresses: null;
  uniqueLpAddressesOmitted: true;
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

export type OlsPoolsResult = {
  OlsPool: Pick<OlsPool, "poolId">[];
};

export type PoolBreachRollupResult = {
  Pool: {
    id: string;
    breachCount?: number;
    healthBinarySeconds?: string;
    healthTotalSeconds?: string;
  }[];
};

export type PoolHealthCursorResult = {
  Pool: {
    id: string;
    lastOracleSnapshotTimestamp?: string;
    lastDeviationRatio?: string;
    lastOracleReportAt?: string;
    oracleExpiry?: string;
  }[];
};

export type PoolRebalanceThresholdsKnownResult = {
  Pool: {
    id: string;
    updatedAtBlock: string;
    rebalanceThresholdAbove?: number;
    rebalanceThresholdBelow?: number;
    rebalanceThresholdsKnown?: boolean;
    tokenDecimalsKnown?: boolean;
    degenerateReserves?: boolean;
    breakerTripped?: boolean;
  }[];
};

export type PoolsVpOracleFreshnessResult = {
  Pool: {
    id: string;
    updatedAtBlock: string;
    oracleTimestamp?: string;
    oracleNumReporters?: number;
    tokenDecimalsKnown?: boolean;
    lastOracleReportAt?: string;
    medianLive?: boolean;
    oracleFreshnessWindow?: string;
  }[];
};

export type ObservedResult<T> = {
  data: T;
  checkedAt: number;
};

export type VpLifecycleDeprecationResult = {
  VirtualPoolLifecycle: { poolId?: string }[];
};

export type PoolLabel = Pick<Pool, "id" | "token0" | "token1" | "source">;

export type PaginatedPageResult<T> = {
  rows: T[];
  truncated: boolean;
  error: Error | null;
  /**
   * Set when an incremental refresh of mutable tail rows failed or was capped.
   * Older cached history can still cover a window's lower timestamp bound, but
   * windows that include the mutable UTC-day buckets must degrade because those
   * rows may now be stale.
   */
  mutableTailError?: Error | null;
};

export type SnapshotPageResult = PaginatedPageResult<PoolSnapshotWindow> & {
  /**
   * False when rows came from a bounded seed whose from-zero completion has
   * not succeeded. Optional for older hand-built fixtures; only explicit
   * false marks the assembled client payload capped.
   */
  historyComplete?: boolean;
};
