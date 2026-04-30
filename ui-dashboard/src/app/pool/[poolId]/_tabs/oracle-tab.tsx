"use client";

import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useNetwork } from "@/components/network-provider";
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
  ORACLE_SNAPSHOTS,
  ORACLE_SNAPSHOTS_CHART,
  ORACLE_SNAPSHOTS_COUNT_PAGE,
} from "@/lib/queries";
import { normalizeSearch } from "@/lib/table-search";
import { buildOrderBy } from "@/lib/table-sort";
import { tokenSymbol } from "@/lib/tokens";
import type { OracleSnapshot, Pool } from "@/lib/types";
import React, { useMemo } from "react";
import { matchesRowSearch } from "../_lib/helpers";
import type { OracleSortCol } from "../_lib/types";

export function OracleTab({
  poolId,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { network } = useNetwork();
  const query = normalizeSearch(search);

  const [rawPage, setRawPage] = React.useState(1);
  const [sortCol, setSortCol] = React.useState<OracleSortCol>("timestamp");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  // Wrap search handler so changing the query always resets to page 1
  const handleSearchChange = React.useCallback(
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
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.OracleSnapshot?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
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
  // Search always uses newest-first so the bounded window is chronologically
  // consistent with what the warning text says ("most recent N snapshots")
  const searchOrderBy = useMemo(() => buildOrderBy("timestamp", "desc"), []);
  const orderBy = isSearching ? searchOrderBy : tableOrderBy;

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
    { poolId, limit: 200 },
  );
  const chartRows = useMemo(() => {
    const raw = chartData?.OracleSnapshot ?? [];
    return [...raw].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }, [chartData]);

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

  const toggleSort = React.useCallback(
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

  if (pool?.source?.includes("virtual")) {
    return <EmptyBox message="VirtualPool — no oracle data available." />;
  }

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return (
      <EmptyBox message="No oracle snapshots yet. Oracle data is captured on pool activity (swaps, rebalances)." />
    );

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
        <>
          <Table>
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50">
                <Th>Source</Th>
                <Th align="right" aria-sort={ariaSortFor("oracleOk")}>
                  <button
                    type="button"
                    onClick={() => toggleSort("oracleOk")}
                    className="hover:text-indigo-400 transition-colors"
                  >
                    Oracle OK{arrow("oracleOk")}
                  </button>
                </Th>
                <Th align="right" aria-sort={ariaSortFor("oraclePrice")}>
                  <button
                    type="button"
                    onClick={() => toggleSort("oraclePrice")}
                    className="hover:text-indigo-400 transition-colors"
                  >
                    Price ({sym0}/{sym1}){arrow("oraclePrice")}
                  </button>
                </Th>
                <Th align="right" aria-sort={ariaSortFor("priceDifference")}>
                  <button
                    type="button"
                    onClick={() => toggleSort("priceDifference")}
                    className="hover:text-indigo-400 transition-colors"
                  >
                    Price Diff{arrow("priceDifference")}
                  </button>
                </Th>
                <Th align="right">Threshold</Th>
                <Th aria-sort={ariaSortFor("timestamp")}>
                  <button
                    type="button"
                    onClick={() => toggleSort("timestamp")}
                    className="hover:text-indigo-400 transition-colors"
                  >
                    Time{arrow("timestamp")}
                  </button>
                </Th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const txUrl = r.txHash
                  ? `${network.explorerBaseUrl}/tx/${r.txHash}`
                  : null;
                const diffBps = Number(r.priceDifference);
                const thresholdBps = r.rebalanceThreshold;
                const diffPct =
                  diffBps > 0 && thresholdBps > 0
                    ? ((diffBps / thresholdBps) * 100).toFixed(1)
                    : null;
                return (
                  <Row key={r.id}>
                    <Td small>
                      {txUrl ? (
                        <a
                          href={txUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 font-mono hover:text-indigo-400 transition-colors"
                        >
                          {r.source}
                        </a>
                      ) : (
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 font-mono">
                          {r.source}
                        </span>
                      )}
                    </Td>
                    <Td small align="right">
                      <span
                        className={
                          r.oracleOk ? "text-emerald-400" : "text-red-400"
                        }
                      >
                        {r.oracleOk ? "✓" : "✗"}
                      </span>
                    </Td>
                    <Td mono small align="right">
                      {parseOraclePriceToNumber(r.oraclePrice, sym0).toFixed(6)}
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
                    <Td small muted title={formatTimestamp(r.timestamp)}>
                      {txUrl ? (
                        <a
                          href={txUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-indigo-400 transition-colors"
                        >
                          {relativeTime(r.timestamp)}
                        </a>
                      ) : (
                        relativeTime(r.timestamp)
                      )}
                    </Td>
                  </Row>
                );
              })}
            </tbody>
          </Table>
          {!isSearching && (
            <Pagination
              page={page}
              pageSize={DEFAULT_PAGE_SIZE}
              total={total}
              onPageChange={setRawPage}
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
      )}
    </>
  );
}
