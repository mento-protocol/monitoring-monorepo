"use client";

import { useAddressLabels } from "@/components/address-labels-provider";
import { EmptyBox } from "@/components/feedback";
import type { useNetwork } from "@/components/network-provider";
import { Pagination } from "@/components/pagination";
import { TableSearch } from "@/components/table-search";
import {
  ENVIO_MAX_ROWS,
  SEARCH_BOOTSTRAP_LIMIT,
  SEARCH_MAX_LIMIT,
} from "@/lib/constants";
import { formatWei } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import {
  OLS_LIQUIDITY_EVENTS_COUNT,
  OLS_LIQUIDITY_EVENTS_PAGE,
} from "@/lib/queries";
import { normalizeSearch } from "@/lib/table-search";
import { buildOrderBy } from "@/lib/table-sort";
import { tokenSymbol } from "@/lib/tokens";
import type { OlsLiquidityEvent, Pool } from "@/lib/types";
import React, { useMemo } from "react";
import { addressSearchTerms, matchesRowSearch } from "../_lib/helpers";
import { OlsLiquidityTable } from "./ols-liquidity-table";

/**
 * Fetches OLS liquidity events scoped to the active OLS contract address,
 * preventing event mixing when a pool has been re-registered to a new OLS contract.
 */
export function OlsLiquidityEvents({
  poolId,
  olsAddress,
  limit,
  pool,
  network,
  search,
  onSearchChange,
}: {
  poolId: string;
  olsAddress: string | null;
  limit: number;
  pool: Pool | null;
  network: ReturnType<typeof useNetwork>["network"];
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { getName, getTags } = useAddressLabels();
  const searchQuery = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const countQuery = olsAddress ? OLS_LIQUIDITY_EVENTS_COUNT : null;
  const { data: countData, error: countError } = useGQL<{
    OlsLiquidityEvent: { id: string }[];
  }>(
    countQuery,
    olsAddress ? { poolId, olsAddress, limit: ENVIO_MAX_ROWS, offset: 0 } : {},
  );
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.OlsLiquidityEvent?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const isSearching = searchQuery.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : limit;
  const fetchOffset = isSearching ? 0 : (page - 1) * limit;
  const orderBy = useMemo(() => buildOrderBy("blockTimestamp", "desc"), []);

  const gqlQuery = olsAddress ? OLS_LIQUIDITY_EVENTS_PAGE : null;
  const { data, error, isLoading } = useGQL<{
    OlsLiquidityEvent: OlsLiquidityEvent[];
  }>(
    gqlQuery,
    olsAddress
      ? { poolId, olsAddress, limit: fetchLimit, offset: fetchOffset, orderBy }
      : {},
  );

  const events = data?.OlsLiquidityEvent ?? [];

  const filteredEvents = useMemo(() => {
    if (!searchQuery) return events;
    return events.filter((e) => {
      const givenSym = tokenSymbol(network, e.tokenGivenToPool);
      const takenSym = tokenSymbol(network, e.tokenTakenFromPool);
      const givenDec =
        pool?.token0?.toLowerCase() === e.tokenGivenToPool.toLowerCase()
          ? (pool?.token0Decimals ?? 18)
          : (pool?.token1Decimals ?? 18);
      const takenDec =
        pool?.token0?.toLowerCase() === e.tokenTakenFromPool.toLowerCase()
          ? (pool?.token0Decimals ?? 18)
          : (pool?.token1Decimals ?? 18);
      return matchesRowSearch(searchQuery, [
        e.txHash,
        e.direction === 0 ? "expand" : "contract",
        ...addressSearchTerms(e.caller, getName, getTags),
        formatWei(e.amountGivenToPool, givenDec),
        givenSym,
        formatWei(e.amountTakenFromPool, takenDec),
        takenSym,
      ]);
    });
  }, [events, searchQuery, pool, network, getName, getTags]);

  return (
    <>
      {events.length > 0 && (
        <TableSearch
          value={search}
          onChange={handleSearchChange}
          placeholder="Search OLS events by tx, caller, direction, amount, or token..."
          ariaLabel="Search OLS events"
        />
      )}
      {error ? (
        <OlsLiquidityTable
          events={[]}
          pool={pool}
          network={network}
          isLoading={false}
          error={error}
        />
      ) : searchQuery && events.length > 0 && filteredEvents.length === 0 ? (
        <EmptyBox message="No OLS events match your search." />
      ) : (
        <OlsLiquidityTable
          events={filteredEvents}
          pool={pool}
          network={network}
          isLoading={isLoading}
          error={null}
        />
      )}
      {!error && !isSearching && (
        <Pagination
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setRawPage}
        />
      )}
      {!error && countCapped && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} OLS events — older
          entries may exist beyond this page range.
        </p>
      )}
      {!error && countCapped && isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search covers the most recent {ENVIO_MAX_ROWS.toLocaleString()} OLS
          events only.
        </p>
      )}
      {!error && countError && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — pagination may be incomplete.
        </p>
      )}
      {!error && countError && isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — search covers the most recent{" "}
          {SEARCH_BOOTSTRAP_LIMIT.toLocaleString()} entries only.
        </p>
      )}
    </>
  );
}
