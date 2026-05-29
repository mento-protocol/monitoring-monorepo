"use client";

import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useNetwork } from "@/components/network-provider";
import type { Network } from "@/lib/networks";
import {
  DAILY_MODE_SPAN_SECONDS,
  OracleChart,
  type OracleDailyCandle,
  lookAheadTarget,
} from "@/components/oracle-chart";
import { Pagination } from "@/components/pagination";
import { Row, Table, Td, Th } from "@/components/table";
import { TableSearch } from "@/components/table-search";
import {
  DEFAULT_PAGE_SIZE,
  ENVIO_MAX_ROWS,
  SEARCH_BOOTSTRAP_LIMIT,
  SEARCH_MAX_LIMIT,
} from "@/lib/constants";
import {
  formatTimestamp,
  parseOraclePriceToNumber,
  relativeTime,
} from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { useWindowedHistory } from "@/lib/use-windowed-history";
import {
  ORACLE_PRICE_DAILY,
  ORACLE_SNAPSHOTS,
  ORACLE_SNAPSHOTS_CHART,
  ORACLE_SNAPSHOTS_COUNT_PAGE,
  POOL_BREAKER_CONFIG,
} from "@/lib/queries";
import { effectiveBreakerThreshold, pickTrippableConfig } from "@/lib/breaker";
import { normalizeSearch } from "@/lib/table-search";
import { buildOrderBy } from "@/lib/table-sort";
import { tokenSymbol } from "@/lib/tokens";
import {
  type BreakerConfig,
  isVirtualPool,
  type OracleSnapshot,
  type Pool,
} from "@/lib/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchesRowSearch } from "../_lib/helpers";
import type { OracleSortCol } from "../_lib/types";
import { usePoolScopedCountFallback } from "../_lib/use-pool-scoped-count-fallback";

type OracleTabProps = {
  poolId: string;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
};

// Search always uses newest-first so the bounded window is chronologically
// consistent with what the warning text says ("most recent N snapshots").
const SEARCH_ORDER_BY = buildOrderBy("timestamp", "desc");

// Stable module-level selector for the windowed-history hook (an unstable
// inline arrow would re-key the head fetch every render).
const selectOracleSnapshots = (data: unknown): OracleSnapshot[] =>
  (data as { OracleSnapshot?: OracleSnapshot[] }).OracleSnapshot ?? [];

// Debounce the stream of relayout events during a pan gesture into one
// look-ahead evaluation, and trigger the next older page once the requested
// left edge gets within this fraction of a span of the oldest loaded point.
const LOOKAHEAD_DEBOUNCE_MS = 150;
const LOOKAHEAD_FRACTION = 0.2;

// Daily OHLC rollup — the chart's zoomed-out resolution. One ≤1000-row page
// spans the full history (vs ~3.5 days of raw medians), so no look-ahead paging
// is needed. Pass the already virtual-pool-guarded `chartQuery` (null on a
// virtual pool → no fetch); inherits the useGQL revalidation gates. Undefined
// while loading → the chart stays on the raw path.
//
// The query orders DESC (so the 1000-row cap drops the oldest days, keeping the
// newest ~2.7yr); reverse to chronological ASC here for the chart's line.
// `[...].reverse()` (not `toReversed`) for the ES2017 target. Memoized so the
// reversed array stays referentially stable across renders.
function useOracleDailyCandles(
  chartQuery: string | null,
  variables: { poolId: string },
): readonly OracleDailyCandle[] | undefined {
  const { data } = useGQL<{ OraclePriceDailySnapshot: OracleDailyCandle[] }>(
    chartQuery ? ORACLE_PRICE_DAILY : null,
    variables,
  );
  const rows = data?.OraclePriceDailySnapshot;
  return useMemo(() => (rows ? [...rows].reverse() : undefined), [rows]);
}

// Debounced look-ahead: when the user pans/zooms so the left edge approaches the
// oldest loaded point, page in the next older raw window. Gated on data-need
// (not event-firing), so the wheel handler's relayouts can't spuriously fetch —
// AND skipped once the viewport widens past DAILY_MODE_SPAN_SECONDS, where the
// chart renders daily candles instead (paging raw history there would walk many
// pages into the Tier-Quota 429 wall for data daily mode never shows). The
// cleanup clears a pending timer on unmount AND on pool/network switch
// (`resetKey`) — the tab doesn't remount across a poolId param change, so
// without that dep a timer armed for the old pool would fire ~150ms later and
// page the freshly-reset new pool.
function useOracleLookAhead({
  oldestLoadedTs,
  ensureLoadedBefore,
  resetKey,
}: {
  oldestLoadedTs: number;
  ensureLoadedBefore: (targetTs: number) => void;
  resetKey: string;
}): (range: [number, number]) => void {
  const lookAheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVisibleXRangeChange = useCallback(
    (range: [number, number]) => {
      if (lookAheadTimer.current) clearTimeout(lookAheadTimer.current);
      if (range[1] - range[0] > DAILY_MODE_SPAN_SECONDS) return;
      lookAheadTimer.current = setTimeout(() => {
        const target = lookAheadTarget(
          range,
          oldestLoadedTs,
          LOOKAHEAD_FRACTION,
        );
        if (target !== null) ensureLoadedBefore(target);
      }, LOOKAHEAD_DEBOUNCE_MS);
    },
    [oldestLoadedTs, ensureLoadedBefore],
  );
  useEffect(
    () => () => {
      if (lookAheadTimer.current) clearTimeout(lookAheadTimer.current);
    },
    [resetKey],
  );
  return handleVisibleXRangeChange;
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity, max-lines-per-function -- Existing tab keeps oracle filtering, pagination, and degraded count state co-located.
export function OracleTab(props: OracleTabProps) {
  const { poolId, pool, search, onSearchChange } = props;
  const { network } = useNetwork();
  const query = normalizeSearch(search);

  const [rawPage, setRawPage] = useState(1);
  const [sortCol, setSortCol] = useState<OracleSortCol>("timestamp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Wrap search handler so changing the query always resets to page 1
  const handleSearchChange = useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const { data: countData, error: countError } = useGQL<{
    OracleSnapshot: { id: string }[];
  }>(ORACLE_SNAPSHOTS_COUNT_PAGE, {
    poolId,
    limit: ENVIO_MAX_ROWS,
    offset: 0,
  });
  // Preserve last known total on count error so pagination stays visible.
  const rawTotal = countData?.OracleSnapshot?.length ?? 0;
  const total = usePoolScopedCountFallback(poolId, rawTotal, !!countError);
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  // Clamp page to valid range once total is known, so a stale page
  // index never leaves the user stranded past the last page.
  const totalPages = total > 0 ? Math.ceil(total / DEFAULT_PAGE_SIZE) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));

  // When search is active: fetch from offset 0 so filtering spans a large
  // bounded window rather than just the current page. Bootstrap before count
  // resolves, then expand up to a capped maximum to avoid unbounded pulls.
  // Always use timestamp desc for search queries so "most recent N" is accurate
  // regardless of the current table sort column.
  const isSearching = query.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : DEFAULT_PAGE_SIZE;
  const isSearchCapped = isSearching && total > SEARCH_MAX_LIMIT;
  const fetchOffset = isSearching ? 0 : (page - 1) * DEFAULT_PAGE_SIZE;
  // Table sort (user-controlled)
  const tableOrderBy = useMemo(
    () => buildOrderBy(sortCol, sortDir, "timestamp"),
    [sortCol, sortDir],
  );
  const orderBy = isSearching ? SEARCH_ORDER_BY : tableOrderBy;

  const { data, error, isLoading } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(ORACLE_SNAPSHOTS, {
    poolId,
    limit: fetchLimit,
    offset: fetchOffset,
    orderBy,
  });

  const rows = data?.OracleSnapshot ?? [];

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  // The chart fetches its own keyset-paginated history (decoupled from table
  // pagination / sort), so it scrolls back past the 1000-row Hasura cap on
  // demand. The live head polls the newest window every 30s; older pages are
  // fetched once and frozen (see `useWindowedHistory`). Persisted breaker
  // bands ride the same query now, so there's no companion fetch to merge.
  const chartQuery =
    pool && isVirtualPool(pool) ? null : ORACLE_SNAPSHOTS_CHART;
  const chartVariables = useMemo(() => ({ poolId }), [poolId]);
  const {
    rows: chartRows,
    oldestLoadedTs,
    reachedStart,
    capped: chartCapped,
    isFetchingOlder,
    olderError,
    headError,
    ensureLoadedBefore,
  } = useWindowedHistory<OracleSnapshot>({
    query: chartQuery,
    variables: chartVariables,
    selectRows: selectOracleSnapshots,
    resetKey: `${network.id}:${poolId}`,
  });

  // Daily OHLC rollup — the chart's zoomed-out resolution (see hook below).
  const dailyCandles = useOracleDailyCandles(chartQuery, chartVariables);

  // Debounced look-ahead paging (raw mode) + cleanup on pool switch; the chart
  // calls this with the visible X range. See the hook for the daily-mode gate.
  const handleVisibleXRangeChange = useOracleLookAhead({
    oldestLoadedTs,
    ensureLoadedBefore,
    resetKey: `${network.id}:${poolId}`,
  });

  // Fetch the active deviation breaker (VALUE_DELTA or MEDIAN_DELTA) for this
  // pool's rate feed. The chart needs `referenceValue` / `medianRatesEMA` as
  // baseline and `rateChangeThreshold` as the trip band — none of which are
  // on OracleSnapshot. We share `POOL_BREAKER_CONFIG` (and its SWR cache key)
  // with `<BreakerPanel />` and `<MarketHoursPill />` so the page issues a
  // single Hasura round-trip for breaker state; the picker below filters out
  // MARKET_HOURS so the chart sees the same trip-able config the panel does.
  // Keep the raw `referenceRateFeedID` (no `.toLowerCase()`) so the SWR cache
  // key matches the two sibling consumers — they pass `pool.referenceRateFeedID
  // ?? ""` verbatim. The indexer stores feed IDs lowercase today, but aligning
  // on the raw value avoids a silent dedup miss if that ever changes.
  const rateFeedID = pool?.referenceRateFeedID ?? "";
  const chainId = pool?.chainId;
  const {
    data: breakerData,
    isLoading: isBreakerLoading,
    error: breakerError,
  } = useGQL<{
    // POOL_BREAKER_CONFIG also returns BreakerTripEvent[], but this consumer
    // only reads BreakerConfig — typing the unread selection out keeps the
    // local shape honest. <BreakerPanel /> consumes the trip events.
    BreakerConfig: BreakerConfig[];
  }>(
    rateFeedID && chainId ? POOL_BREAKER_CONFIG : null,
    rateFeedID && chainId ? { chainId, rateFeedID } : undefined,
  );
  const breakerConfig = useMemo(() => {
    const configs = breakerData?.BreakerConfig ?? [];
    const row = pickTrippableConfig(configs);
    if (!row) return null;
    // Per-feed `rateChangeThreshold` is a sentinel `0` when the feed inherits
    // the breaker default; `effectiveBreakerThreshold` resolves that so the
    // chart band reflects the truly-applied limit instead of collapsing to 0.
    return {
      breakerKind: row.breaker.kind,
      rateChangeThreshold: effectiveBreakerThreshold(row).toString(),
      referenceValue: row.referenceValue,
      medianRatesEMA: row.medianRatesEMA,
      status: row.status,
      lastTripAt: row.lastTripAt,
    };
  }, [breakerData]);
  // The chart distinguishes "breaker config not loaded yet" from "no breaker
  // for this feed" so it can render a neutral state in the first case rather
  // than greenwashing un-bounded points. A fetch error collapses to "missing"
  // — same neutral copy, the failure shows up in the network panel.
  //
  // "ready" also requires the kind-specific baseline to be non-null and
  // non-zero. A MEDIAN_DELTA breaker right after `MedianRateEMAReset` has
  // `medianRatesEMA = "0"` until the next positive median seeds it; treating
  // that as "ready" would let the legend advertise "within/outside current
  // band" semantics while no band can actually be drawn. BreakerPanel has
  // the same "unseeded → not ready" carve-out.
  const breakerHasBaseline = breakerConfig
    ? breakerConfig.breakerKind === "VALUE_DELTA"
      ? !!breakerConfig.referenceValue && breakerConfig.referenceValue !== "0"
      : !!breakerConfig.medianRatesEMA && breakerConfig.medianRatesEMA !== "0"
    : false;
  const breakerConfigStatus: "loading" | "ready" | "missing" =
    !rateFeedID || !chainId
      ? "missing"
      : breakerError
        ? "missing"
        : isBreakerLoading
          ? "loading"
          : breakerConfig && breakerHasBaseline
            ? "ready"
            : "missing";

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      const statusAliases = r.oracleOk
        ? "ok true healthy pass good ✓"
        : "fail false unhealthy bad ✗";
      return matchesRowSearch(query, [
        r.source,
        statusAliases,
        parseOraclePriceToNumber(r.oraclePrice, sym0).toFixed(6),
        Number(r.priceDifference) > 0 ? r.priceDifference : null,
        r.rebalanceThreshold > 0 ? String(r.rebalanceThreshold) : null,
        r.txHash,
      ]);
    });
  }, [rows, query, sym0]);

  const toggleSort = useCallback(
    (col: OracleSortCol) => {
      if (sortCol === col) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortCol(col);
        setSortDir(col === "oracleOk" ? "asc" : "desc");
      }
      setRawPage(1);
    },
    [sortCol],
  );

  if (pool && isVirtualPool(pool)) {
    return <EmptyBox message="VirtualPool — no oracle data available." />;
  }

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return (
      <EmptyBox message="No oracle snapshots yet. Oracle data is captured on pool activity (swaps, rebalances)." />
    );

  return (
    <>
      {pool?.deviationBreachStartedAt &&
        Number(pool.deviationBreachStartedAt) > 0 && (
          <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-2.5 mb-4 text-sm text-red-300">
            Deviation breach started{" "}
            {relativeTime(pool.deviationBreachStartedAt)} — oracle price
            deviation exceeds the rebalance threshold.
          </div>
        )}
      {chartRows.length > 0 && chartRows.length < 20 && (
        <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 px-4 py-2 mb-4 text-xs text-slate-400">
          Only {chartRows.length} oracle snapshot
          {chartRows.length === 1 ? "" : "s"} recorded so far — data is still
          collecting.
        </div>
      )}
      <OracleChart
        snapshots={chartRows}
        token0Symbol={sym0}
        token1Symbol={sym1}
        breachStartedAt={pool?.deviationBreachStartedAt}
        breakerConfig={breakerConfig}
        breakerConfigStatus={breakerConfigStatus}
        uirevision={`${network.id}:${poolId}`}
        onVisibleXRangeChange={handleVisibleXRangeChange}
        dailyCandles={dailyCandles}
      />
      <OracleChartScrollbackStatus
        isFetchingOlder={isFetchingOlder}
        olderError={olderError}
        headError={headError}
        hasChartRows={chartRows.length > 0}
        capped={chartCapped}
        reachedStart={reachedStart}
        oldestLoadedTs={oldestLoadedTs}
      />
      <TableSearch
        value={search}
        onChange={handleSearchChange}
        placeholder="Search oracle rows by source, status, price, or tx hash…"
        ariaLabel="Search oracle"
      />
      {filteredRows.length === 0 ? (
        <EmptyBox message="No oracle snapshots match your search." />
      ) : (
        <OracleSnapshotsTable
          rows={filteredRows}
          network={network}
          sym0={sym0}
          sym1={sym1}
          sortCol={sortCol}
          sortDir={sortDir}
          isSearching={isSearching}
          onSort={toggleSort}
          page={page}
          total={total}
          onPageChange={setRawPage}
          countCapped={countCapped}
          countError={countError}
          isSearchCapped={isSearchCapped}
        />
      )}
    </>
  );
}

// Passive status line under the chart for the scroll-back lifecycle. No toast:
// a transient older-page error must not tear down the rendered history.
function OracleChartScrollbackStatus({
  isFetchingOlder,
  olderError,
  headError,
  hasChartRows,
  capped,
  reachedStart,
  oldestLoadedTs,
}: {
  isFetchingOlder: boolean;
  olderError: Error | undefined;
  headError: Error | undefined;
  hasChartRows: boolean;
  capped: boolean;
  reachedStart: boolean;
  oldestLoadedTs: number;
}) {
  // Head-poll failure with nothing rendered yet: the chart area is blank, so
  // tell the operator it's a fetch failure (not "no oracle data"). SWR retries
  // the head automatically. When history IS already rendered we stay quiet —
  // the last-good series keeps showing and the failure is in the network panel.
  if (headError && !hasChartRows) {
    return (
      <p className="px-1 -mt-3 mb-4 text-xs text-amber-400" role="status">
        Could not load live oracle data — retrying…
      </p>
    );
  }
  if (isFetchingOlder) {
    return (
      <p className="px-1 -mt-3 mb-4 text-xs text-slate-500" role="status">
        Loading older history…
      </p>
    );
  }
  if (olderError) {
    const back =
      Number.isFinite(oldestLoadedTs) && oldestLoadedTs > 0
        ? ` back to ${formatTimestamp(String(oldestLoadedTs))}`
        : "";
    return (
      <p className="px-1 -mt-3 mb-4 text-xs text-amber-400" role="status">
        Could not load older snapshots — showing data{back}. Pan left again to
        retry.
      </p>
    );
  }
  if (capped) {
    return (
      <p className="px-1 -mt-3 mb-4 text-xs text-amber-400" role="status">
        Loaded the maximum history window — older entries exist beyond this
        range.
      </p>
    );
  }
  if (reachedStart) {
    return (
      <p className="px-1 -mt-3 mb-4 text-xs text-slate-600" role="status">
        Beginning of recorded oracle history.
      </p>
    );
  }
  return null;
}

type OracleSnapshotsTableProps = {
  rows: OracleSnapshot[];
  network: Network;
  sym0: string;
  sym1: string;
  sortCol: OracleSortCol;
  sortDir: "asc" | "desc";
  isSearching: boolean;
  onSort: (col: OracleSortCol) => void;
  page: number;
  total: number;
  onPageChange: (page: number) => void;
  countCapped: boolean;
  countError: Error | undefined;
  isSearchCapped: boolean;
};

function OracleSnapshotsTableHeader({
  sym0,
  sym1,
  sortCol,
  sortDir,
  isSearching,
  onSort,
}: {
  sym0: string;
  sym1: string;
  sortCol: OracleSortCol;
  sortDir: "asc" | "desc";
  isSearching: boolean;
  onSort: (col: OracleSortCol) => void;
}) {
  // Arrows and aria-sort are suppressed during search: sort controls remain
  // clickable (to stage a sort for when search is cleared) but the UI does not
  // announce a sort that isn't currently applied to the visible rows.
  const arrow = (col: OracleSortCol) =>
    !isSearching && sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : "";
  const ariaSortFor = (
    col: OracleSortCol,
  ): "ascending" | "descending" | "none" =>
    !isSearching && sortCol === col
      ? sortDir === "asc"
        ? "ascending"
        : "descending"
      : "none";
  return (
    <thead>
      <tr className="border-b border-slate-800 bg-slate-900/50">
        <Th>Source</Th>
        <Th align="right" aria-sort={ariaSortFor("oracleOk")}>
          <button
            type="button"
            onClick={() => onSort("oracleOk")}
            className="hover:text-indigo-400 transition-colors"
          >
            Oracle OK{arrow("oracleOk")}
          </button>
        </Th>
        <Th align="right" aria-sort={ariaSortFor("oraclePrice")}>
          <button
            type="button"
            onClick={() => onSort("oraclePrice")}
            className="hover:text-indigo-400 transition-colors"
          >
            Price ({sym0}/{sym1}){arrow("oraclePrice")}
          </button>
        </Th>
        <Th align="right" aria-sort={ariaSortFor("priceDifference")}>
          <button
            type="button"
            onClick={() => onSort("priceDifference")}
            className="hover:text-indigo-400 transition-colors"
          >
            Price Diff{arrow("priceDifference")}
          </button>
        </Th>
        <Th align="right">Threshold</Th>
        <Th aria-sort={ariaSortFor("timestamp")}>
          <button
            type="button"
            onClick={() => onSort("timestamp")}
            className="hover:text-indigo-400 transition-colors"
          >
            Time{arrow("timestamp")}
          </button>
        </Th>
      </tr>
    </thead>
  );
}

function OracleSnapshotsTable({
  rows,
  network,
  sym0,
  sym1,
  sortCol,
  sortDir,
  isSearching,
  onSort,
  page,
  total,
  onPageChange,
  countCapped,
  countError,
  isSearchCapped,
}: OracleSnapshotsTableProps) {
  return (
    <>
      <Table>
        <OracleSnapshotsTableHeader
          sym0={sym0}
          sym1={sym1}
          sortCol={sortCol}
          sortDir={sortDir}
          isSearching={isSearching}
          onSort={onSort}
        />
        <tbody>
          {rows.map((r) => (
            <OracleSnapshotRow
              key={r.id}
              row={r}
              network={network}
              sym0={sym0}
            />
          ))}
        </tbody>
      </Table>
      {!isSearching && (
        <Pagination
          page={page}
          pageSize={DEFAULT_PAGE_SIZE}
          total={total}
          onPageChange={onPageChange}
        />
      )}
      {countCapped && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} snapshots — older
          entries may exist beyond this page range.
        </p>
      )}
      {!countError && isSearchCapped && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search is limited to the most recent{" "}
          {SEARCH_MAX_LIMIT.toLocaleString()} snapshots.
        </p>
      )}
      {countError && isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — search covers the most recent{" "}
          {SEARCH_BOOTSTRAP_LIMIT.toLocaleString()} snapshots only.
        </p>
      )}
      {countError && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — pagination may be incomplete.
        </p>
      )}
    </>
  );
}

function priceDifferencePresentation(
  diffBps: number,
  diffPct: string | null,
  degenerateReserves: boolean,
) {
  if (!degenerateReserves && diffBps <= 0) {
    return {
      visible: false,
      label: "—",
      title: "",
      showBadge: false,
      className: undefined,
    };
  }
  const title = degenerateReserves
    ? `${diffBps.toLocaleString()} bps from effectively one-sided reserves`
    : `${diffBps.toLocaleString()} bps`;
  const label =
    diffBps > 0 ? (diffPct !== null ? `${diffPct}%` : `${diffBps} bps`) : "—";
  return {
    visible: true,
    label,
    title,
    showBadge: degenerateReserves,
    className: degenerateReserves ? "text-amber-300" : undefined,
  };
}

function OracleSnapshotRow({
  row,
  network,
  sym0,
}: {
  row: OracleSnapshot;
  network: Network;
  sym0: string;
}) {
  const txUrl = row.txHash
    ? `${network.explorerBaseUrl}/tx/${row.txHash}`
    : null;
  const diffBps = Number(row.priceDifference);
  const thresholdBps = row.rebalanceThreshold;
  const degenerateReserves = row.degenerateReserves === true;
  // `hasHealthData=false` rows preserve the previous priceDifference and may
  // carry a raw threshold of 0 or an unread fallback — show "—" rather than
  // fake a %.
  const diffPct =
    row.hasHealthData !== false && diffBps > 0 && thresholdBps > 0
      ? ((diffBps / thresholdBps) * 100).toFixed(1)
      : null;
  const diffPresentation = priceDifferencePresentation(
    diffBps,
    diffPct,
    degenerateReserves,
  );

  return (
    <Row>
      <Td small>
        {txUrl ? (
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 font-mono hover:text-indigo-400 transition-colors"
          >
            {row.source}
          </a>
        ) : (
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 font-mono">
            {row.source}
          </span>
        )}
      </Td>
      <Td small align="right">
        <span className={row.oracleOk ? "text-emerald-400" : "text-red-400"}>
          {row.oracleOk ? "✓" : "✗"}
        </span>
      </Td>
      <Td mono small align="right">
        {parseOraclePriceToNumber(row.oraclePrice, sym0).toFixed(6)}
      </Td>
      <Td mono small align="right">
        {diffPresentation.visible ? (
          <span
            className={diffPresentation.className}
            title={diffPresentation.title}
          >
            {diffPresentation.label}
            {diffPresentation.showBadge && (
              <span className="ml-1 rounded border border-amber-500/40 px-1 text-[9px] uppercase text-amber-300">
                one-sided
              </span>
            )}
          </span>
        ) : (
          "—"
        )}
      </Td>
      <Td mono small align="right">
        {thresholdBps > 0 ? (
          <span title={`${thresholdBps.toLocaleString()} bps`}>
            {(thresholdBps / 100).toFixed(2)}%
          </span>
        ) : (
          "—"
        )}
      </Td>
      <Td small muted title={formatTimestamp(row.timestamp)}>
        {txUrl ? (
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-indigo-400 transition-colors"
          >
            {relativeTime(row.timestamp)}
          </a>
        ) : (
          relativeTime(row.timestamp)
        )}
      </Td>
    </Row>
  );
}
