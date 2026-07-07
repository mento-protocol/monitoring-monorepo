"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import { ErrorBox, Skeleton } from "@/components/feedback";
import { Row, Table, Td, Th } from "@/components/table";
import { TxHashCell } from "@/components/tx-hash-cell";
import { formatBlock, formatTimestamp, relativeTime } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";
import {
  ALL_CDP_STABILITY_POOL_EVENTS,
  ALL_CDP_TRANSACTIONS,
  ALL_CDP_TROVE_OP_SNAPSHOTS,
} from "@/lib/queries";
import Link from "next/link";
import { cdpSymbolSlug } from "../_lib/format";
import {
  BADGE_LABELS,
  BADGE_STYLES,
  CDP_OVERVIEW_PER_KIND_FETCH_LIMIT,
  type BadgeKind,
  badgeKindFor,
  indexSnapshotsById,
  mergeTransactionRows,
  positionSnapshotFor,
  type CdpStabilityPoolEventsResponse,
  type CdpTransactionsResponse,
  type CdpTroveOpSnapshotResponse,
} from "../_lib/transactions";
import type { CdpTransactionRow, CdpTroveOpSnapshotRow } from "../_lib/types";
import { CdpTxAmountCell } from "./cdp-tx-amount-cell";
import {
  ADDRESS_FILTER_POOL_EVENT_NOTICE,
  ADDRESS_FILTER_SP_ONLY_NOTICE,
  CdpTxAddressFilter,
  CdpTxMarketFilter,
  CdpTxTypeFilter,
  TX_FILTER_TYPE_ORDER,
  normalizeAddressFilter,
} from "./cdp-tx-filters";
import {
  CdpTransactionsEmptyState,
  StabilityPoolEventsUnavailableNotice,
} from "./cdp-transaction-notices";

// 100 across all markets is the user-visible cap. We fetch a larger
// per-kind cap and merge so the latest 100 across kinds is accurate even
// when one kind dominates (e.g. trove ops far outnumber liquidations).
const MAX_ROWS = 100;
const CDP_TYPE_QUERY_PARAM = "type";
const CDP_MARKET_QUERY_PARAM = "market";
const CDP_ADDRESS_QUERY_PARAM = "address";
const TX_FILTER_TYPE_SET = new Set<BadgeKind>(TX_FILTER_TYPE_ORDER);

interface CollateralSummary {
  id: string;
  symbol: string;
  chainId: number;
}

interface OverviewFilterSnapshot {
  typeFilter: BadgeKind | null;
  marketFilter: string | null;
  addressInput: string;
}

export function CdpAllTransactionsTable({
  collaterals,
  chainId,
}: {
  collaterals: CollateralSummary[];
  chainId: number;
}) {
  const { data, error, isLoading } = useGQL<CdpTransactionsResponse>(
    ALL_CDP_TRANSACTIONS,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  const stabilityPoolEvents = useGQL<CdpStabilityPoolEventsResponse>(
    ALL_CDP_STABILITY_POOL_EVENTS,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  // Isolated query for the schema-lag-fragile fields (owner + before/after).
  // Errors and loading states are tracked independently so the table keeps
  // rendering with flat amounts and a disabled address filter when this
  // query fails during a deploy+resync window.
  const snapshots = useGQL<CdpTroveOpSnapshotResponse>(
    ALL_CDP_TROVE_OP_SNAPSHOTS,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  const { rows, capped } = useMemo(
    () =>
      mergeTransactionRows(
        data,
        CDP_OVERVIEW_PER_KIND_FETCH_LIMIT,
        stabilityPoolEvents.data,
      ),
    [data, stabilityPoolEvents.data],
  );
  const snapshotById = useMemo(
    () => indexSnapshotsById(snapshots.data),
    [snapshots.data],
  );
  const snapshotsReady = snapshots.data != null && snapshots.error == null;
  const stabilityPoolEventsUnavailable = stabilityPoolEvents.error != null;

  const symbolByInstance = useMemo(() => {
    const m = new Map<string, { symbol: string; chainId: number }>();
    for (const c of collaterals) {
      m.set(c.id, { symbol: c.symbol, chainId: c.chainId });
    }
    return m;
  }, [collaterals]);

  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        Recent CDP Transactions
      </h2>
      {hasErrorWithoutData(error, data) ? (
        <ErrorBox
          message={`Failed to load CDP transactions — ${error.message}`}
        />
      ) : isLoadingWithoutData(isLoading, data) ||
        (rows.length === 0 &&
          isLoadingWithoutData(
            stabilityPoolEvents.isLoading,
            stabilityPoolEvents.data,
          )) ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <CdpTransactionsEmptyState
          stabilityPoolEventsUnavailable={stabilityPoolEventsUnavailable}
        />
      ) : (
        <OverviewBody
          rows={rows}
          collaterals={collaterals}
          symbolByInstance={symbolByInstance}
          capped={capped}
          stabilityPoolEventsUnavailable={stabilityPoolEventsUnavailable}
          snapshotById={snapshotById}
          snapshotsReady={snapshotsReady}
        />
      )}
    </section>
  );
}

/** Filter state for the overview transactions table. Combines:
 *  - validated `marketFilter` (falls back to null if the indexer drops or
 *    renames a market between revalidations, so a stale id can't silently
 *    zero out the result set without a visibly selected pill)
 *  - free-text `addressInput` (normalized to lowercase + trimmed at the
 *    comparison site so the input renders the raw typed value)
 *  URL canonicalization clears malformed type/market/address params once the
 *  collateral list is available, while derived `addressActive` still absorbs
 *  degraded owner-data availability. */
function readOverviewFiltersFromParams(
  params: URLSearchParams,
  collaterals: CollateralSummary[],
): OverviewFilterSnapshot {
  return {
    typeFilter: parseTypeFilter(params),
    marketFilter: normalizeMarketFilter(parseMarketFilter(params), collaterals),
    addressInput: parseAddressInput(params),
  };
}

function parseTypeFilter(params: URLSearchParams): BadgeKind | null {
  const raw = params.get(CDP_TYPE_QUERY_PARAM);
  return raw && TX_FILTER_TYPE_SET.has(raw as BadgeKind)
    ? (raw as BadgeKind)
    : null;
}

function parseMarketFilter(params: URLSearchParams): string | null {
  const raw = params.get(CDP_MARKET_QUERY_PARAM)?.trim();
  return raw ? raw : null;
}

function parseAddressInput(params: URLSearchParams): string {
  return normalizeAddressFilter(params.get(CDP_ADDRESS_QUERY_PARAM) ?? "");
}

function normalizeMarketFilter(
  marketFilter: string | null,
  collaterals: CollateralSummary[],
): string | null {
  if (marketFilter == null) return null;
  return collaterals.some((c) => c.id === marketFilter) ? marketFilter : null;
}

function buildOverviewFiltersSearch(
  currentSearch: string,
  { typeFilter, marketFilter, addressInput }: OverviewFilterSnapshot,
): string {
  const params = new URLSearchParams(currentSearch);
  if (typeFilter == null) {
    params.delete(CDP_TYPE_QUERY_PARAM);
  } else {
    params.set(CDP_TYPE_QUERY_PARAM, typeFilter);
  }
  if (marketFilter == null) {
    params.delete(CDP_MARKET_QUERY_PARAM);
  } else {
    params.set(CDP_MARKET_QUERY_PARAM, marketFilter);
  }
  const normalizedAddress = normalizeAddressFilter(addressInput);
  if (normalizedAddress === "") {
    params.delete(CDP_ADDRESS_QUERY_PARAM);
  } else {
    params.set(CDP_ADDRESS_QUERY_PARAM, normalizedAddress);
  }
  return params.toString();
}

function replaceOverviewFiltersUrl(nextSearch: string) {
  if (typeof window === "undefined") return;
  const nextUrl =
    window.location.pathname +
    (nextSearch ? `?${nextSearch}` : "") +
    window.location.hash;
  window.history.replaceState(window.history.state, "", nextUrl);
}

function writeOverviewFiltersUrl(next: OverviewFilterSnapshot) {
  if (typeof window === "undefined") return;
  replaceOverviewFiltersUrl(
    buildOverviewFiltersSearch(window.location.search, next),
  );
}

function syncOverviewFilterState({
  next,
  setTypeFilterState,
  setMarketFilterState,
  setAddressInputState,
}: {
  next: OverviewFilterSnapshot;
  setTypeFilterState: Dispatch<SetStateAction<BadgeKind | null>>;
  setMarketFilterState: Dispatch<SetStateAction<string | null>>;
  setAddressInputState: Dispatch<SetStateAction<string>>;
}) {
  setTypeFilterState((prev) =>
    prev === next.typeFilter ? prev : next.typeFilter,
  );
  setMarketFilterState((prev) =>
    prev === next.marketFilter ? prev : next.marketFilter,
  );
  setAddressInputState((prev) =>
    prev === next.addressInput ? prev : next.addressInput,
  );
}

interface OverviewUrlFilterState {
  typeFilter: BadgeKind | null;
  setTypeFilter: (next: BadgeKind | null) => void;
  marketFilter: string | null;
  setMarketFilter: (next: string | null) => void;
  effectiveMarketFilter: string | null;
  addressInput: string;
  setAddressInput: (next: string) => void;
}

function useOverviewUrlFilterState(
  collaterals: CollateralSummary[],
): OverviewUrlFilterState {
  // `useSearchParams()` is the SSR-pass source for direct `/cdps?...` loads.
  // Runtime writes/readbacks use `window.location.search` so our own
  // `replaceState` writes compose with sibling URL-state writers.
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();
  const initialReadParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : searchParams;
  const initialFilters = readOverviewFiltersFromParams(
    initialReadParams,
    collaterals,
  );

  const [typeFilter, setTypeFilterState] = useState<BadgeKind | null>(
    initialFilters.typeFilter,
  );
  const [marketFilter, setMarketFilterState] = useState<string | null>(
    initialFilters.marketFilter,
  );
  const [addressInput, setAddressInputState] = useState(
    initialFilters.addressInput,
  );
  const effectiveMarketFilter = useMemo(() => {
    if (marketFilter == null) return null;
    return collaterals.some((c) => c.id === marketFilter) ? marketFilter : null;
  }, [collaterals, marketFilter]);

  const writeFiltersUrl = useCallback(
    (next: OverviewFilterSnapshot) => {
      writeOverviewFiltersUrl({
        ...next,
        marketFilter: normalizeMarketFilter(next.marketFilter, collaterals),
      });
    },
    [collaterals],
  );

  const setTypeFilter = useCallback(
    (next: BadgeKind | null) => {
      setTypeFilterState(next);
      writeFiltersUrl({
        typeFilter: next,
        marketFilter: effectiveMarketFilter,
        addressInput,
      });
    },
    [addressInput, effectiveMarketFilter, writeFiltersUrl],
  );
  const setMarketFilter = useCallback(
    (next: string | null) => {
      setMarketFilterState(next);
      writeFiltersUrl({
        typeFilter,
        marketFilter: next,
        addressInput,
      });
    },
    [addressInput, typeFilter, writeFiltersUrl],
  );
  const setAddressInput = useCallback(
    (next: string) => {
      setAddressInputState(next);
      writeFiltersUrl({
        typeFilter,
        marketFilter: effectiveMarketFilter,
        addressInput: next,
      });
    },
    [effectiveMarketFilter, typeFilter, writeFiltersUrl],
  );
  useCanonicalOverviewFilterUrl(
    collaterals,
    setTypeFilterState,
    setMarketFilterState,
    setAddressInputState,
  );
  useOverviewFilterPopState(
    collaterals,
    setTypeFilterState,
    setMarketFilterState,
    setAddressInputState,
  );

  return {
    typeFilter,
    setTypeFilter,
    marketFilter: effectiveMarketFilter,
    setMarketFilter,
    effectiveMarketFilter,
    addressInput,
    setAddressInput,
  };
}

function useCanonicalOverviewFilterUrl(
  collaterals: CollateralSummary[],
  setTypeFilterState: Dispatch<SetStateAction<BadgeKind | null>>,
  setMarketFilterState: Dispatch<SetStateAction<string | null>>,
  setAddressInputState: Dispatch<SetStateAction<string>>,
) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = new URLSearchParams(window.location.search);
    const next = readOverviewFiltersFromParams(current, collaterals);
    syncOverviewFilterState({
      next,
      setTypeFilterState,
      setMarketFilterState,
      setAddressInputState,
    });
    const canonicalSearch = buildOverviewFiltersSearch(
      window.location.search,
      next,
    );
    if (canonicalSearch !== current.toString()) {
      replaceOverviewFiltersUrl(canonicalSearch);
    }
  }, [
    collaterals,
    setAddressInputState,
    setMarketFilterState,
    setTypeFilterState,
  ]);
}

function useOverviewFilterPopState(
  collaterals: CollateralSummary[],
  setTypeFilterState: Dispatch<SetStateAction<BadgeKind | null>>,
  setMarketFilterState: Dispatch<SetStateAction<string | null>>,
  setAddressInputState: Dispatch<SetStateAction<string>>,
) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const next = readOverviewFiltersFromParams(
        new URLSearchParams(window.location.search),
        collaterals,
      );
      syncOverviewFilterState({
        next,
        setTypeFilterState,
        setMarketFilterState,
        setAddressInputState,
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [
    collaterals,
    setAddressInputState,
    setMarketFilterState,
    setTypeFilterState,
  ]);
}

function useFilteredOverviewRows({
  rows,
  typeFilter,
  effectiveMarketFilter,
  addressInput,
  snapshotById,
  snapshotsReady,
}: {
  rows: CdpTransactionRow[];
  typeFilter: BadgeKind | null;
  effectiveMarketFilter: string | null;
  addressInput: string;
  snapshotById: Map<string, CdpTroveOpSnapshotRow>;
  snapshotsReady: boolean;
}) {
  const normalizedAddress = normalizeAddressFilter(addressInput);
  const hasStabilityPoolRows = rows.some((row) => row.kind === "spOperation");
  const addressEnabled = snapshotsReady || hasStabilityPoolRows;
  const addressActive = normalizedAddress.length > 0 && addressEnabled;
  const addressFilterNotice =
    addressActive && snapshotsReady
      ? ADDRESS_FILTER_POOL_EVENT_NOTICE
      : addressActive
        ? ADDRESS_FILTER_SP_ONLY_NOTICE
        : null;
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (addressActive) {
        const matchesAddress =
          row.kind === "spOperation"
            ? row.depositor === normalizedAddress
            : row.kind === "troveOp" &&
              snapshotById.get(row.id)?.owner === normalizedAddress;
        if (!matchesAddress) return false;
      }
      if (typeFilter != null && badgeKindFor(row) !== typeFilter) return false;
      if (
        effectiveMarketFilter != null &&
        row.instanceId !== effectiveMarketFilter
      )
        return false;
      return true;
    });
  }, [
    rows,
    typeFilter,
    effectiveMarketFilter,
    addressActive,
    normalizedAddress,
    snapshotById,
  ]);
  return {
    addressDisabled: !addressEnabled,
    addressFilterNotice,
    addressActive,
    filteredRows,
  };
}

function useOverviewFilters(
  rows: CdpTransactionRow[],
  collaterals: CollateralSummary[],
  snapshotById: Map<string, CdpTroveOpSnapshotRow>,
  snapshotsReady: boolean,
) {
  const {
    typeFilter,
    setTypeFilter,
    marketFilter,
    setMarketFilter,
    effectiveMarketFilter,
    addressInput,
    setAddressInput,
  } = useOverviewUrlFilterState(collaterals);
  const { addressDisabled, addressFilterNotice, addressActive, filteredRows } =
    useFilteredOverviewRows({
      rows,
      typeFilter,
      effectiveMarketFilter,
      addressInput,
      snapshotById,
      snapshotsReady,
    });

  return {
    typeFilter,
    setTypeFilter,
    marketFilter,
    setMarketFilter,
    addressInput,
    setAddressInput,
    addressDisabled,
    addressFilterNotice,
    filteredRows,
    filtersActive:
      typeFilter != null || effectiveMarketFilter != null || addressActive,
  };
}

/** Filter bar for the overview transactions table — type-pill row,
 *  market-pill row, and free-text owner input. Extracted from
 *  `OverviewBody` to keep that component under the project's
 *  `max-lines-per-function` budget. */
function OverviewFilterBar({
  collaterals,
  typeFilter,
  onTypeFilterChange,
  marketFilter,
  onMarketFilterChange,
  addressInput,
  onAddressInputChange,
  addressDisabled,
  addressFilterNotice,
}: {
  collaterals: CollateralSummary[];
  typeFilter: BadgeKind | null;
  onTypeFilterChange: (next: BadgeKind | null) => void;
  marketFilter: string | null;
  onMarketFilterChange: (next: string | null) => void;
  addressInput: string;
  onAddressInputChange: (next: string) => void;
  addressDisabled: boolean;
  addressFilterNotice: string | null;
}) {
  return (
    <div className="mb-3 space-y-2">
      <CdpTxTypeFilter
        options={TX_FILTER_TYPE_ORDER}
        selected={typeFilter}
        onChange={onTypeFilterChange}
      />
      <CdpTxMarketFilter
        options={collaterals}
        selected={marketFilter}
        onChange={onMarketFilterChange}
      />
      <CdpTxAddressFilter
        value={addressInput}
        onChange={onAddressInputChange}
        disabled={addressDisabled}
        disabledHint={
          addressDisabled ? "(unavailable while indexer syncs)" : undefined
        }
      />
      {addressFilterNotice != null && (
        <p role="status" className="px-1 text-xs text-slate-500">
          {addressFilterNotice}
        </p>
      )}
    </div>
  );
}

function OverviewBody({
  rows,
  collaterals,
  symbolByInstance,
  capped,
  stabilityPoolEventsUnavailable,
  snapshotById,
  snapshotsReady,
}: {
  rows: CdpTransactionRow[];
  collaterals: CollateralSummary[];
  symbolByInstance: Map<string, { symbol: string; chainId: number }>;
  capped: boolean;
  stabilityPoolEventsUnavailable: boolean;
  snapshotById: Map<string, CdpTroveOpSnapshotRow>;
  snapshotsReady: boolean;
}) {
  const {
    typeFilter,
    setTypeFilter,
    marketFilter,
    setMarketFilter,
    addressInput,
    setAddressInput,
    addressDisabled,
    addressFilterNotice,
    filteredRows,
    filtersActive,
  } = useOverviewFilters(rows, collaterals, snapshotById, snapshotsReady);
  const visibleRows = filteredRows.slice(0, MAX_ROWS);

  return (
    <>
      <OverviewFilterBar
        collaterals={collaterals}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        marketFilter={marketFilter}
        onMarketFilterChange={setMarketFilter}
        addressInput={addressInput}
        onAddressInputChange={setAddressInput}
        addressDisabled={addressDisabled}
        addressFilterNotice={addressFilterNotice}
      />
      <Table>
        <thead>
          <Row>
            <Th>Type</Th>
            <Th>Market</Th>
            <Th align="right">Debt</Th>
            <Th align="right">Collateral</Th>
            <Th>Tx</Th>
            <th
              scope="col"
              className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-right"
            >
              Block
            </th>
            <Th>Time</Th>
          </Row>
        </thead>
        <tbody>
          {visibleRows.length === 0 ? (
            <Row>
              <td
                colSpan={7}
                className="px-2 sm:px-4 py-3 text-center text-xs text-slate-500"
              >
                No transactions match the active filters.
              </td>
            </Row>
          ) : (
            visibleRows.map((row) => (
              <OverviewRow
                key={`${row.kind}-${row.id}`}
                row={row}
                market={
                  row.instanceId
                    ? symbolByInstance.get(row.instanceId)
                    : undefined
                }
                snapshot={
                  row.kind === "troveOp" ? snapshotById.get(row.id) : undefined
                }
              />
            ))
          )}
        </tbody>
      </Table>
      <OverviewFootnotes
        visibleCount={visibleRows.length}
        filteredCount={filteredRows.length}
        filtersActive={filtersActive}
        capped={capped}
        stabilityPoolEventsUnavailable={stabilityPoolEventsUnavailable}
      />
    </>
  );
}

function OverviewFootnotes({
  visibleCount,
  filteredCount,
  filtersActive,
  capped,
  stabilityPoolEventsUnavailable,
}: {
  visibleCount: number;
  filteredCount: number;
  filtersActive: boolean;
  capped: boolean;
  stabilityPoolEventsUnavailable: boolean;
}) {
  return (
    <>
      {visibleCount > 0 && (
        <p className="px-1 pt-2 text-xs text-slate-500">
          {filtersActive
            ? `Showing ${visibleCount.toLocaleString()} of ${filteredCount.toLocaleString()} matching transactions.`
            : `Showing the most recent ${visibleCount.toLocaleString()} transactions across all CDP markets.`}
        </p>
      )}
      {capped && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing the most recent{" "}
          {CDP_OVERVIEW_PER_KIND_FETCH_LIMIT.toLocaleString()} entries per event
          type — older history may exist beyond this range.
        </p>
      )}
      {stabilityPoolEventsUnavailable && (
        <StabilityPoolEventsUnavailableNotice />
      )}
    </>
  );
}

function OverviewRow({
  row,
  market,
  snapshot,
}: {
  row: CdpTransactionRow;
  market: { symbol: string; chainId: number } | undefined;
  snapshot: CdpTroveOpSnapshotRow | undefined;
}) {
  const kind = badgeKindFor(row);
  const symbol = market?.symbol ?? "—";
  const resolvedSnapshot = positionSnapshotFor(row, snapshot);
  return (
    <Row>
      <Td>
        <span
          className={`inline-block rounded border px-2 py-0.5 text-xs ${BADGE_STYLES[kind]}`}
        >
          {BADGE_LABELS[kind]}
        </span>
      </Td>
      <Td>
        {market ? (
          <Link
            href={`/cdps/${cdpSymbolSlug(market.symbol)}`}
            className="text-indigo-400 hover:text-indigo-300"
          >
            {market.symbol}
          </Link>
        ) : (
          <span className="text-slate-500">{symbol}</span>
        )}
      </Td>
      <CdpTxAmountCell
        row={row}
        symbol={symbol}
        leg="debt"
        snapshot={resolvedSnapshot}
      />
      <CdpTxAmountCell
        row={row}
        symbol="USDm"
        leg="coll"
        snapshot={resolvedSnapshot}
      />
      <TxHashCell txHash={row.txHash} chainId={market?.chainId} />
      <td className="hidden md:table-cell px-2 sm:px-4 py-1.5 sm:py-2 font-mono text-[10px] sm:text-xs text-slate-400 text-right">
        {formatBlock(row.blockNumber)}
      </td>
      <Td small muted title={formatTimestamp(row.timestamp)}>
        {relativeTime(row.timestamp)}
      </Td>
    </Row>
  );
}
