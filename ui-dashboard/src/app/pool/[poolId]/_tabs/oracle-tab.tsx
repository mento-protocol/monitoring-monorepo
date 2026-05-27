"use client";

import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useNetwork } from "@/components/network-provider";
import type { Network } from "@/lib/networks";
import { OracleChart } from "@/components/oracle-chart";
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
import {
  BREAKER_CONFIG_FOR_RATE_FEED,
  ORACLE_SNAPSHOTS,
  ORACLE_SNAPSHOTS_CHART,
  ORACLE_SNAPSHOTS_COUNT_PAGE,
} from "@/lib/queries";
import { normalizeSearch } from "@/lib/table-search";
import { buildOrderBy } from "@/lib/table-sort";
import { tokenSymbol } from "@/lib/tokens";
import { isVirtualPool, type OracleSnapshot, type Pool } from "@/lib/types";
import { useCallback, useMemo, useState } from "react";
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

// eslint-disable-next-line complexity, max-lines-per-function -- Existing tab keeps oracle filtering, pagination, and degraded count state co-located.
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

  // Charts use a dedicated query (200 most recent rows) so they always show
  // full history context regardless of table pagination or sort state.
  const { data: chartData } = useGQL<{ OracleSnapshot: OracleSnapshot[] }>(
    ORACLE_SNAPSHOTS_CHART,
    // Hasura caps every query at 1000 rows. 1000 covers >7d at the typical
    // oracle-snapshot cadence (heartbeat + delta-triggered), which is the
    // default visible window the chart opens to.
    { poolId, limit: 1000 },
  );
  const chartRows = useMemo(() => {
    const raw = chartData?.OracleSnapshot ?? [];
    // ES2023 `toSorted` requires Safari 16+/Chrome 110+; TS target is
    // ES2017 with no polyfill — keep the spread+sort form (codex P2).
    // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
    return [...raw].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }, [chartData]);

  // Fetch the active deviation breaker (VALUE_DELTA or MEDIAN_DELTA) for this
  // pool's rate feed. The chart needs `referenceValue` / `medianRatesEMA` as
  // baseline and `rateChangeThreshold` as the trip band — none of which are
  // on OracleSnapshot.
  const rateFeedID = pool?.referenceRateFeedID?.toLowerCase();
  const chainId = pool?.chainId;
  const { data: breakerData } = useGQL<{
    BreakerConfig: Array<{
      id: string;
      breaker: { kind: "MEDIAN_DELTA" | "VALUE_DELTA" | "MARKET_HOURS" };
      rateChangeThreshold: string;
      referenceValue: string | null;
      medianRatesEMA: string | null;
      lastMedianRate: string | null;
      status: "OK" | "TRIPPED";
      lastTripAt: string | null;
      cooldownTime: string;
    }>;
  }>(
    rateFeedID && chainId ? BREAKER_CONFIG_FOR_RATE_FEED : null,
    rateFeedID && chainId ? { rateFeedID, chainId } : undefined,
  );
  const breakerConfig = useMemo(() => {
    const row = breakerData?.BreakerConfig?.[0];
    if (!row) return null;
    return {
      breakerKind: row.breaker.kind,
      rateChangeThreshold: row.rateChangeThreshold,
      referenceValue: row.referenceValue,
      medianRatesEMA: row.medianRatesEMA,
      status: row.status,
      lastTripAt: row.lastTripAt,
    };
  }, [breakerData]);

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
    <>
      <Table>
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
  // `hasHealthData=false` rows preserve the previous priceDifference and may
  // carry a raw threshold of 0 or an unread fallback — show "—" rather than
  // fake a %.
  const diffPct =
    row.hasHealthData !== false && diffBps > 0 && thresholdBps > 0
      ? ((diffBps / thresholdBps) * 100).toFixed(1)
      : null;

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
        {diffBps > 0 ? (
          <span title={`${diffBps.toLocaleString()} bps`}>
            {diffPct !== null ? `${diffPct}%` : `${diffBps} bps`}
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
