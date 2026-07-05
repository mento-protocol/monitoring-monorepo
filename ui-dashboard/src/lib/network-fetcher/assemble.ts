// Pure assembly of the final `NetworkData` payload from already-resolved
// per-source results. Owns two jobs that must stay decoupled from I/O so
// they can be unit-tested directly: (1) deriving each field's value/error/
// truncation state from its Promise.allSettled result, and (2) the window
// error-precedence matrix — whether a 24h/7d/30d window is degraded by
// pagination truncation, a mutable-tail refresh failure, or neither. See
// `resolveWindowErrors` for the precedence rule itself.

import type { Network } from "@/lib/networks";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import { buildOracleRateMap, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolDailyFeeSnapshot } from "@/lib/types";
import { filterSnapshotsToWindow, type TimeRange } from "@/lib/volume";
import { SECONDS_PER_DAY } from "./constants";
import { toError } from "./errors";
import { mutableDayCutoff } from "./pagination";
import type {
  BrokerDailySnapshotRow,
  NetworkData,
  OlsPoolsResult,
  PaginatedPageResult,
  SnapshotPageResult,
} from "./types";

/**
 * Per-window error precedence: a window is degraded by the mutable-tail
 * refresh failure if the window extends into the mutable UTC-day range;
 * otherwise it's degraded by pagination truncation/error only if we didn't
 * fetch back far enough to cover the window's lower bound. Mutable-tail
 * issues take precedence because rows inside the window may now be stale
 * even though older history is intact; pagination issues only matter when
 * the window's `from` bound falls outside what we actually fetched.
 */
export function resolveWindowErrors(args: {
  windows: { w24h: TimeRange; w7d: TimeRange; w30d: TimeRange };
  oldestFetchedTs: number;
  paginationIssue: Error | null;
  mutableTailIssue: Error | null;
  mutableTailFrom: number;
}): {
  snapshotsError: Error | null;
  snapshots7dError: Error | null;
  snapshots30dError: Error | null;
} {
  const {
    windows,
    oldestFetchedTs,
    paginationIssue,
    mutableTailIssue,
    mutableTailFrom,
  } = args;
  const windowError = (windowFrom: number, windowTo: number): Error | null =>
    mutableTailIssue !== null && windowTo > mutableTailFrom
      ? mutableTailIssue
      : paginationIssue !== null && oldestFetchedTs > windowFrom
        ? paginationIssue
        : null;
  return {
    snapshotsError: windowError(windows.w24h.from, windows.w24h.to),
    snapshots7dError: windowError(windows.w7d.from, windows.w7d.to),
    snapshots30dError: windowError(windows.w30d.from, windows.w30d.to),
  };
}

function deriveFeeSlice(args: {
  feeSnapshotsResult: PromiseSettledResult<
    PaginatedPageResult<PoolDailyFeeSnapshot>
  >;
  pools: Pool[];
  rates: OracleRateMap;
  network: Network;
}): {
  feeSnapshots: PoolDailyFeeSnapshot[];
  feeSnapshotsError: Error | null;
  feeSnapshotsTruncated: boolean;
  fees: ProtocolFeeSummary | null;
  ratesError: Error | null;
} {
  const { feeSnapshotsResult, pools, rates, network } = args;
  const feeSnapshots =
    feeSnapshotsResult.status === "fulfilled"
      ? feeSnapshotsResult.value.rows
      : [];
  const feeSnapshotsError =
    feeSnapshotsResult.status === "rejected"
      ? toError(feeSnapshotsResult.reason)
      : (feeSnapshotsResult.value.error ?? null);
  // Cap-exhaustion: helper returns `truncated: true, error: null`. We still
  // aggregate from the rows we did fetch; consumers gate on this flag to
  // mark the all-time total approximate.
  const feeSnapshotsTruncated =
    feeSnapshotsResult.status === "fulfilled" &&
    feeSnapshotsResult.value.truncated;
  // Rates failure on the homepage SSR path: rates are derived from `pools`
  // (no separate query), so a query-level rates failure already early-
  // returned via the pools-fetch catch in `fetchNetworkData`. The remaining
  // failure mode is an empty rate map despite non-empty pools — every
  // oracle pool has `oracleOk: false` or no oracle pools exist on this
  // chain — which would silently mis-price FX-token slots. Match the hook's
  // fail-loud invariant: blank the tile instead of a confidently-wrong total.
  const ratesError =
    pools.length > 0 && rates.size === 0
      ? new Error(
          `Oracle rates unavailable for ${network.label} — FX-token fees can't be priced`,
        )
      : null;
  const fees =
    feeSnapshotsResult.status === "fulfilled" &&
    feeSnapshotsResult.value.error === null &&
    ratesError === null
      ? aggregateProtocolFees(feeSnapshots, rates)
      : null;
  return {
    feeSnapshots,
    feeSnapshotsError,
    feeSnapshotsTruncated,
    fees,
    ratesError,
  };
}

function deriveBrokerSlice(
  result: PromiseSettledResult<PaginatedPageResult<BrokerDailySnapshotRow>>,
): {
  brokerSnapshotsAllDaily: BrokerDailySnapshotRow[];
  brokerSnapshotsAllDailyTruncated: boolean;
  brokerSnapshotsAllDailyError: Error | null;
} {
  // Legacy v2 daily volume — already filtered to `routedViaV3Router=false`
  // server-side, so no client-side disambiguation is needed.
  return {
    brokerSnapshotsAllDaily:
      result.status === "fulfilled" ? result.value.rows : [],
    brokerSnapshotsAllDailyTruncated:
      result.status === "fulfilled" && result.value.truncated,
    brokerSnapshotsAllDailyError:
      result.status === "rejected"
        ? toError(result.reason)
        : (result.value.error ?? null),
  };
}

function deriveLpSlice(
  result: PromiseSettledResult<PaginatedPageResult<{ address: string }>>,
): {
  uniqueLpAddresses: string[] | null;
  uniqueLpAddressesTruncated: boolean;
  lpError: Error | null;
} {
  // fetchAllLpAddressPages deduplicates by address.toLowerCase() internally,
  // so the rows are already unique — no second Set pass needed.
  return {
    uniqueLpAddresses:
      result.status === "fulfilled"
        ? result.value.rows.map((r) => r.address)
        : null,
    uniqueLpAddressesTruncated:
      result.status === "fulfilled" && result.value.truncated,
    lpError:
      result.status === "rejected"
        ? toError(result.reason)
        : (result.value.error ?? null),
  };
}

function deriveOlsPoolIds(
  result: PromiseSettledResult<OlsPoolsResult>,
): Set<string> {
  return result.status === "fulfilled"
    ? new Set((result.value.OlsPool ?? []).map((p) => p.poolId))
    : new Set<string>();
}

/**
 * Derives the snapshotsAllDaily/snapshots7d/snapshots30d/snapshots slices
 * plus their per-window errors. Window-specific arrays are derived in-memory
 * from `snapshotsAllDaily` — no separate requests, no server-side cap. If
 * pagination truncated (hit MAX_PAGES or mid-loop fetch failure) we keep the
 * most-recent rows we did fetch: 24h/7d/30d derive correctly from those and
 * "All" is flagged as partial.
 */
function deriveSnapshotSlice(args: {
  nowSeconds: number;
  snapshotsAllDailyResult: PromiseSettledResult<SnapshotPageResult>;
  snapshotTailNowMs: number;
}): {
  snapshotsAllDaily: NetworkData["snapshotsAllDaily"];
  snapshotsAllDailyTruncated: boolean;
  snapshotsAllDailyError: Error | null;
  snapshots: NetworkData["snapshots"];
  snapshots7d: NetworkData["snapshots7d"];
  snapshots30d: NetworkData["snapshots30d"];
  snapshotsError: Error | null;
  snapshots7dError: Error | null;
  snapshots30dError: Error | null;
} {
  const { nowSeconds, snapshotsAllDailyResult, snapshotTailNowMs } = args;
  const snapshotsAllDaily =
    snapshotsAllDailyResult.status === "fulfilled"
      ? snapshotsAllDailyResult.value.rows
      : [];
  const snapshotsAllDailyTruncated =
    snapshotsAllDailyResult.status === "fulfilled"
      ? snapshotsAllDailyResult.value.truncated
      : false;
  const snapshotsAllDailyError =
    snapshotsAllDailyResult.status === "rejected"
      ? toError(snapshotsAllDailyResult.reason)
      : (snapshotsAllDailyResult.value.error ?? null);

  // PoolDailySnapshot rows are UTC-midnight-aligned incremental aggregates
  // (one row per pool per UTC day). Anchoring on today's UTC midnight gives
  // exactly 1/7/30 daily rows per KPI window without overcounting.
  //
  // `nowSeconds` is the caller's snapshot of "now" (`windows.w24h.to`), so
  // deriving todayMidnight from it keeps all three windows consistent with
  // the same clock tick rather than calling Date.now() again.
  const todayMidnight =
    Math.floor(nowSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const dw24h: TimeRange = {
    from: todayMidnight,
    to: todayMidnight + SECONDS_PER_DAY,
  };
  const dw7d: TimeRange = {
    from: todayMidnight - 6 * SECONDS_PER_DAY,
    to: todayMidnight + SECONDS_PER_DAY,
  };
  const dw30d: TimeRange = {
    from: todayMidnight - 29 * SECONDS_PER_DAY,
    to: todayMidnight + SECONDS_PER_DAY,
  };

  const snapshots7d = filterSnapshotsToWindow(snapshotsAllDaily, dw7d);
  const snapshots30d = filterSnapshotsToWindow(snapshotsAllDaily, dw30d);

  // Per-window error detection. Pagination issues (error or truncation) only
  // affect a specific window if we didn't fetch far enough back to cover its
  // `from` bound. Rows come in newest-first, so the last element is the
  // oldest we fetched.
  const oldestFetchedTs =
    snapshotsAllDaily.length > 0
      ? Number(snapshotsAllDaily[snapshotsAllDaily.length - 1]!.timestamp)
      : Number.POSITIVE_INFINITY;
  const paginationIssue: Error | null =
    snapshotsAllDailyError ??
    (snapshotsAllDailyTruncated
      ? new Error(
          "Snapshot pagination truncated before reaching the requested window",
        )
      : null);
  const mutableTailIssue: Error | null =
    snapshotsAllDailyResult.status === "fulfilled"
      ? (snapshotsAllDailyResult.value.mutableTailError ?? null)
      : null;
  const mutableTailFrom = mutableDayCutoff(snapshotTailNowMs);

  const { snapshotsError, snapshots7dError, snapshots30dError } =
    resolveWindowErrors({
      windows: { w24h: dw24h, w7d: dw7d, w30d: dw30d },
      oldestFetchedTs,
      paginationIssue,
      mutableTailIssue,
      mutableTailFrom,
    });

  return {
    snapshotsAllDaily,
    snapshotsAllDailyTruncated,
    snapshotsAllDailyError,
    snapshots: filterSnapshotsToWindow(snapshotsAllDaily, dw24h),
    snapshots7d,
    snapshots30d,
    snapshotsError,
    snapshots7dError,
    snapshots30dError,
  };
}

export type AssembleNetworkDataArgs = {
  network: Network;
  windows: { w24h: TimeRange; w7d: TimeRange; w30d: TimeRange };
  pools: Pool[];
  snapshotTailNowMs: number;
  feeSnapshotsResult: PromiseSettledResult<
    PaginatedPageResult<PoolDailyFeeSnapshot>
  >;
  snapshotsAllDailyResult: PromiseSettledResult<SnapshotPageResult>;
  brokerSnapshotsAllDailyResult: PromiseSettledResult<
    PaginatedPageResult<BrokerDailySnapshotRow>
  >;
  lpResult: PromiseSettledResult<PaginatedPageResult<{ address: string }>>;
  olsResult: PromiseSettledResult<OlsPoolsResult>;
  cdpPoolIds: Set<string>;
  reservePoolIds: Set<string>;
  strategyError: Error | null;
};

/**
 * Pure assembly of the final `NetworkData` payload from fully-merged `pools`
 * and each source's settled result. Never performs I/O — safe to unit test
 * directly with hand-built `PromiseSettledResult`s (see
 * `__tests__/assemble.test.ts`), which is what gives the window
 * error-precedence matrix direct coverage instead of riding along
 * `fetchNetworkData`'s full GraphQL-mock characterization tests.
 */
export function assembleNetworkData(
  args: AssembleNetworkDataArgs,
): NetworkData {
  const {
    network,
    windows,
    pools,
    snapshotTailNowMs,
    feeSnapshotsResult,
    snapshotsAllDailyResult,
    brokerSnapshotsAllDailyResult,
    lpResult,
    olsResult,
    cdpPoolIds,
    reservePoolIds,
    strategyError,
  } = args;

  const rates = buildOracleRateMap(pools, network);
  const feeSlice = deriveFeeSlice({
    feeSnapshotsResult,
    pools,
    rates,
    network,
  });
  const snapshotSlice = deriveSnapshotSlice({
    nowSeconds: windows.w24h.to,
    snapshotsAllDailyResult,
    snapshotTailNowMs,
  });
  const brokerSlice = deriveBrokerSlice(brokerSnapshotsAllDailyResult);
  const lpSlice = deriveLpSlice(lpResult);
  const olsPoolIds = deriveOlsPoolIds(olsResult);

  return {
    network,
    snapshotWindows: windows,
    pools,
    ...snapshotSlice,
    ...brokerSlice,
    olsPoolIds,
    cdpPoolIds,
    reservePoolIds,
    strategyError,
    ...feeSlice,
    poolLabels: new Map(),
    ...lpSlice,
    rates,
    error: null,
  };
}
