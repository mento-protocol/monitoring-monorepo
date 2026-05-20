"use client";

import { useAddressLabels } from "@/components/address-labels-provider";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useNetwork } from "@/components/network-provider";
import { Pagination } from "@/components/pagination";
import { SenderCell } from "@/components/sender-cell";
import { SnapshotChart } from "@/components/snapshot-chart";
import { Row, Table, Td, Th } from "@/components/table";
import { TableSearch } from "@/components/table-search";
import { TagsCell } from "@/components/tags-cell";
import { TxHashCell } from "@/components/tx-hash-cell";
import {
  ENVIO_MAX_ROWS,
  SEARCH_BOOTSTRAP_LIMIT,
  SEARCH_MAX_LIMIT,
} from "@/lib/constants";
import {
  formatBlock,
  formatTimestamp,
  formatWei,
  getSwapDirection,
  relativeTime,
} from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import {
  POOL_DAILY_SNAPSHOTS_CHART,
  POOL_REBALANCES,
  POOL_SWAPS_COUNT,
  POOL_SWAPS_PAGE,
} from "@/lib/queries";
import { normalizeSearch } from "@/lib/table-search";
import { buildOrderBy } from "@/lib/table-sort";
import { isFpmm, tokenSymbol } from "@/lib/tokens";
import type { Pool, PoolSnapshot, SwapEvent } from "@/lib/types";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import React, { useMemo } from "react";
import { addressSearchTerms, matchesRowSearch } from "../_lib/helpers";
import { usePoolScopedCountFallback } from "../_lib/use-pool-scoped-count-fallback";

// eslint-disable-next-line complexity, max-lines-per-function -- Existing tab keeps swap filters, pagination, and fallback counters in one query surface.
export function SwapsTab({
  poolId,
  limit,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { network } = useNetwork();
  const { getName, getTags } = useAddressLabels();
  const query = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const { data: countData, error: countError } = useGQL<{
    SwapEvent: { id: string }[];
  }>(POOL_SWAPS_COUNT, { poolId, limit: ENVIO_MAX_ROWS, offset: 0 });
  const rawTotal = countData?.SwapEvent?.length ?? 0;
  const total = usePoolScopedCountFallback(poolId, rawTotal, !!countError);
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const isSearching = query.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : limit;
  const fetchOffset = isSearching ? 0 : (page - 1) * limit;
  const orderBy = useMemo(() => buildOrderBy("blockNumber", "desc"), []);

  const { data, error, isLoading } = useGQL<{ SwapEvent: SwapEvent[] }>(
    POOL_SWAPS_PAGE,
    { poolId, limit: fetchLimit, offset: fetchOffset, orderBy },
  );
  const swaps = data?.SwapEvent ?? [];

  const fpmmPool = pool ? isFpmm(pool) : false;
  // Daily rollup: one row per pool per UTC day, returned in chronological (asc)
  // order. Server-side aggregation avoids the 1000-row cap that hourly hit.
  // `snapshotError` is surfaced inline below so a rollout lag or transient
  // Hasura failure doesn't silently strip the chart from the swaps tab.
  const { data: snapshotData, error: snapshotError } = useGQL<{
    PoolDailySnapshot: PoolSnapshot[];
  }>(
    fpmmPool ? POOL_DAILY_SNAPSHOTS_CHART : null,
    { poolId },
    SNAPSHOT_REFRESH_MS,
  );
  const snapshots = snapshotData?.PoolDailySnapshot ?? [];
  const lastSnapshot = snapshots[0];

  const { data: rebalanceData } = useGQL<{
    RebalanceEvent: { blockTimestamp: string }[];
  }>(fpmmPool ? POOL_REBALANCES : null, { poolId, limit: 200 });
  const rebalanceTimestamps = useMemo(
    () => (rebalanceData?.RebalanceEvent ?? []).map((r) => r.blockTimestamp),
    [rebalanceData],
  );

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  const dec0 = pool?.token0Decimals ?? 18;
  const dec1 = pool?.token1Decimals ?? 18;

  const filteredSwaps = useMemo(() => {
    if (!query) return swaps;
    return swaps.filter((s) => {
      const d = getSwapDirection(s, sym0, sym1, dec0, dec1);

      return matchesRowSearch(query, [
        s.txHash,
        ...addressSearchTerms(s.sender, getName, getTags),
        ...addressSearchTerms(s.recipient, getName, getTags),
        d.soldSym,
        d.boughtSym,
        formatWei(d.soldAmt, d.soldDec),
        formatWei(d.boughtAmt, d.boughtDec),
        s.blockNumber,
      ]);
    });
  }, [swaps, query, sym0, sym1, dec0, dec1, getName, getTags]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;

  return (
    <>
      {fpmmPool && snapshotError && (
        <ErrorBox
          message={`Daily volume chart unavailable: ${snapshotError.message}`}
        />
      )}
      {fpmmPool && snapshots.length > 0 && (
        <>
          <SnapshotChart
            snapshots={snapshots}
            token0Symbol={sym0}
            token1Symbol={sym1}
            pool={pool}
            rebalanceTimestamps={rebalanceTimestamps}
          />
          <SnapshotSummary
            snapshot={lastSnapshot}
            dec0={dec0}
            dec1={dec1}
            sym0={sym0}
            sym1={sym1}
          />
        </>
      )}
      {swaps.length > 0 && (
        <TableSearch
          value={search}
          onChange={handleSearchChange}
          placeholder="Search swaps by tx, address, name, tag, token, amount, or block…"
          ariaLabel="Search swaps"
        />
      )}
      {swaps.length === 0 ? (
        <EmptyBox message="No swaps for this pool." />
      ) : filteredSwaps.length === 0 ? (
        <EmptyBox message="No swaps match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Tx</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Sender
              </th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Tags
              </th>
              <Th>Trader</Th>
              <Th align="right">Sold</Th>
              <Th align="right">Bought</Th>
              <th
                scope="col"
                className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-right"
              >
                Rate
              </th>
              <th
                scope="col"
                className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-right"
              >
                Block
              </th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredSwaps.map((s) => {
              const d = getSwapDirection(s, sym0, sym1, dec0, dec1);
              return (
                <Row key={s.id}>
                  <TxHashCell txHash={s.txHash} />
                  <SenderCell
                    address={s.sender}
                    className="hidden sm:table-cell"
                  />
                  <TagsCell
                    address={s.sender}
                    className="hidden sm:table-cell"
                  />
                  <SenderCell address={s.recipient} />
                  <Td mono small align="right">
                    {formatWei(d.soldAmt, d.soldDec)} {d.soldSym}
                  </Td>
                  <Td mono small align="right">
                    {formatWei(d.boughtAmt, d.boughtDec)} {d.boughtSym}
                  </Td>
                  <td className="hidden lg:table-cell px-2 sm:px-4 py-1.5 sm:py-2 font-mono text-[10px] sm:text-xs text-slate-400 text-right">
                    {(() => {
                      const sold = Number(d.soldAmt) / 10 ** d.soldDec;
                      const bought = Number(d.boughtAmt) / 10 ** d.boughtDec;
                      return sold > 0 ? (bought / sold).toFixed(6) : "—";
                    })()}
                  </td>
                  <td className="hidden md:table-cell px-2 sm:px-4 py-1.5 sm:py-2 font-mono text-[10px] sm:text-xs text-slate-400 text-right">
                    {formatBlock(s.blockNumber)}
                  </td>
                  <Td small muted title={formatTimestamp(s.blockTimestamp)}>
                    {relativeTime(s.blockTimestamp)}
                  </Td>
                </Row>
              );
            })}
          </tbody>
        </Table>
      )}
      {!isSearching && (
        <Pagination
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setRawPage}
        />
      )}
      {countCapped && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} swaps — older entries
          may exist beyond this page range.
        </p>
      )}
      {countCapped && isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search covers the most recent {ENVIO_MAX_ROWS.toLocaleString()} swaps
          only.
        </p>
      )}
      {countError && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — pagination may be incomplete.
        </p>
      )}
      {countError && isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — search covers the most recent{" "}
          {SEARCH_BOOTSTRAP_LIMIT.toLocaleString()} entries only.
        </p>
      )}
    </>
  );
}

function SnapshotSummary({
  snapshot,
  dec0,
  dec1,
  sym0,
  sym1,
}: {
  snapshot: PoolSnapshot | undefined;
  dec0: number;
  dec1: number;
  sym0: string;
  sym1: string;
}) {
  if (!snapshot) return null;
  return (
    <div className="flex flex-wrap gap-4 mb-4 text-xs text-slate-400">
      <span>
        Cumulative:{" "}
        <span className="font-mono text-slate-300">
          {formatWei(snapshot.cumulativeVolume0, dec0)}
        </span>{" "}
        {sym0} sold
      </span>
      <span>
        <span className="font-mono text-slate-300">
          {formatWei(snapshot.cumulativeVolume1, dec1)}
        </span>{" "}
        {sym1} sold
      </span>
      <span>
        <span className="font-mono text-slate-300">
          {snapshot.cumulativeSwapCount.toLocaleString()}
        </span>{" "}
        total swaps
      </span>
    </div>
  );
}
