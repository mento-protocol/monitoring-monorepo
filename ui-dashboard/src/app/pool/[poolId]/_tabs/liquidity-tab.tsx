"use client";

import { useAddressLabels } from "@/components/address-labels-provider";
import { KindBadge } from "@/components/badges";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { LiquidityChart } from "@/components/liquidity-chart";
import { useNetwork } from "@/components/network-provider";
import { Pagination } from "@/components/pagination";
import { SenderCell } from "@/components/sender-cell";
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
  relativeTime,
} from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import {
  POOL_DAILY_SNAPSHOTS_CHART,
  POOL_LIQUIDITY_COUNT,
  POOL_LIQUIDITY_PAGE,
} from "@/lib/queries";
import { normalizeSearch } from "@/lib/table-search";
import { buildOrderBy } from "@/lib/table-sort";
import { isFpmm, tokenSymbol } from "@/lib/tokens";
import type { LiquidityEvent, Pool, PoolSnapshot } from "@/lib/types";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import React, { useMemo } from "react";
import { addressSearchTerms, matchesRowSearch } from "../_lib/helpers";

export function LiquidityTab({
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
    LiquidityEvent: { id: string }[];
  }>(POOL_LIQUIDITY_COUNT, { poolId, limit: ENVIO_MAX_ROWS, offset: 0 });
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.LiquidityEvent?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const isSearching = query.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : limit;
  const fetchOffset = isSearching ? 0 : (page - 1) * limit;
  const orderBy = useMemo(() => buildOrderBy("blockNumber", "desc"), []);

  const { data, error, isLoading } = useGQL<{
    LiquidityEvent: LiquidityEvent[];
  }>(POOL_LIQUIDITY_PAGE, {
    poolId,
    limit: fetchLimit,
    offset: fetchOffset,
    orderBy,
  });
  const rows = data?.LiquidityEvent ?? [];

  const fpmmPool = pool ? isFpmm(pool) : false;
  // Same POOL_DAILY_SNAPSHOTS_CHART query that PoolDetail and SwapsTab issue.
  // SWR dedupes on (network.id, query, vars) so only one network request
  // fires; the local hook gives this tab its own loading/error branches.
  const { data: snapshotData, error: snapshotError } = useGQL<{
    PoolDailySnapshot: PoolSnapshot[];
  }>(
    fpmmPool ? POOL_DAILY_SNAPSHOTS_CHART : null,
    { poolId },
    SNAPSHOT_REFRESH_MS,
  );
  const snapshots = useMemo(
    () => [...(snapshotData?.PoolDailySnapshot ?? [])].reverse(),
    [snapshotData],
  );

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      return matchesRowSearch(query, [
        r.txHash,
        r.kind,
        ...addressSearchTerms(r.sender, getName, getTags),
        formatWei(r.amount0),
        formatWei(r.amount1),
        formatWei(r.liquidity),
        sym0,
        sym1,
        r.blockNumber,
      ]);
    });
  }, [rows, query, getName, getTags, sym0, sym1]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;

  return (
    <>
      {fpmmPool && snapshotError && (
        <ErrorBox
          message={`Liquidity chart unavailable: ${snapshotError.message}`}
        />
      )}
      {fpmmPool && snapshots.length > 0 && (
        <LiquidityChart
          snapshots={snapshots}
          pool={pool}
          token0Symbol={sym0}
          token1Symbol={sym1}
        />
      )}
      {rows.length > 0 && (
        <TableSearch
          value={search}
          onChange={handleSearchChange}
          placeholder="Search liquidity by tx, sender, name, tag, kind, amount, or block…"
          ariaLabel="Search liquidity"
        />
      )}
      {rows.length === 0 ? (
        <EmptyBox message="No liquidity events for this pool." />
      ) : filteredRows.length === 0 ? (
        <EmptyBox message="No liquidity events match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Tx</Th>
              <Th>Kind</Th>
              <Th>Sender</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Tags
              </th>
              <Th align="right">Amount 0</Th>
              <Th align="right">Amount 1</Th>
              <Th align="right">Liquidity</Th>
              <Th align="right">Block</Th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <Row key={r.id}>
                <TxHashCell txHash={r.txHash} />
                <td className="px-4 py-2">
                  <KindBadge kind={r.kind} />
                </td>
                <SenderCell address={r.sender} />
                <TagsCell address={r.sender} className="hidden sm:table-cell" />
                <Td mono small align="right">
                  {formatWei(r.amount0)}
                </Td>
                <Td mono small align="right">
                  {formatWei(r.amount1)}
                </Td>
                <Td mono small align="right">
                  {formatWei(r.liquidity)}
                </Td>
                <Td mono small muted align="right">
                  {formatBlock(r.blockNumber)}
                </Td>
                <Td small muted title={formatTimestamp(r.blockTimestamp)}>
                  {relativeTime(r.blockTimestamp)}
                </Td>
              </Row>
            ))}
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
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} liquidity events —
          older entries may exist beyond this page range.
        </p>
      )}
      {countCapped && isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search covers the most recent {ENVIO_MAX_ROWS.toLocaleString()}{" "}
          liquidity events only.
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
