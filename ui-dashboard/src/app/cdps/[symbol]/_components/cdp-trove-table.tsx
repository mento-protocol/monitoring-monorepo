"use client";

import { useMemo, useState, type ReactNode } from "react";
import { EmptyBox } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { Table, Row } from "@/components/table";
import type { SortDir } from "@/lib/table-sort";
import { useRovingTabIndex } from "@/lib/use-roving-tab-index";
import { useTableSort } from "@/lib/use-table-sort";
import {
  CDP_TROVES_DETAIL_LIMIT,
  type CdpCollateral,
  type CdpInterestBatch,
  type CdpTrove,
} from "../../_lib/types";
import { HistoryTroveHeader, OpenTroveHeader } from "./trove-table-headers";
import {
  HISTORY_SORT_DEFAULT_DIR,
  HISTORY_SORT_DEFAULT_KEY,
  HISTORY_SORT_KEYS,
  OPEN_SORT_DEFAULT_DIR,
  OPEN_SORT_DEFAULT_KEY,
  OPEN_SORT_KEYS,
  sortDisplayRows,
  type HistorySortKey,
  type OpenSortKey,
  type TroveDisplayRow,
  type TroveSortKey,
} from "./trove-sort";
import { TroveRow } from "./trove-cells";
import {
  buildHistoryRows,
  buildRankedOpenRows,
  troveMatchesSearch,
} from "./trove-row-data";

const TROVE_TABS = ["open", "history"] as const;

type TroveTab = (typeof TROVE_TABS)[number];

const TROVE_PAGE_SIZE = 25;

const troveTabId = (tab: TroveTab) => `cdp-trove-tab-${tab}`;
const trovePanelId = (tab: TroveTab) => `cdp-trove-panel-${tab}`;

export function CdpTroveTable({
  openTroves,
  allTroves,
  interestBatches,
  collateral,
}: {
  openTroves: CdpTrove[];
  allTroves: CdpTrove[];
  interestBatches: CdpInterestBatch[];
  collateral: CdpCollateral;
}) {
  const [activeTab, setActiveTab] = useState<TroveTab>("open");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const openSort = useTableSort<OpenSortKey>({
    defaultKey: OPEN_SORT_DEFAULT_KEY,
    defaultDir: OPEN_SORT_DEFAULT_DIR,
    validKeys: OPEN_SORT_KEYS,
    paramPrefix: "troves",
  });
  const historySort = useTableSort<HistorySortKey>({
    defaultKey: HISTORY_SORT_DEFAULT_KEY,
    defaultDir: HISTORY_SORT_DEFAULT_DIR,
    validKeys: HISTORY_SORT_KEYS,
    paramPrefix: "trovesHist",
  });
  const activeSort = activeTab === "open" ? openSort : historySort;
  const tableRows = useTroveTableRows({
    activeTab,
    search,
    page,
    sortKey: activeSort.sortKey,
    sortDir: activeSort.sortDir,
    openTroves,
    allTroves,
    interestBatches,
  });

  const selectTab = (next: TroveTab) => {
    setActiveTab(next);
    setPage(1);
  };
  const updateSearch = (next: string) => {
    setSearch(next);
    setPage(1);
  };
  const handleSort = (key: TroveSortKey) => {
    setPage(1);
    if (activeTab === "open") {
      openSort.handleSort(key as OpenSortKey);
    } else {
      historySort.handleSort(key as HistorySortKey);
    }
  };

  return (
    <section>
      <TroveTableHeader
        activeTab={activeTab}
        search={search}
        onSelectTab={selectTab}
        onSearch={updateSearch}
      />
      <div
        role="tabpanel"
        id={trovePanelId(activeTab)}
        aria-labelledby={troveTabId(activeTab)}
      >
        {tableRows.sourceRows.length === 0 ? (
          <EmptyBox message={tableRows.emptyMessage} />
        ) : (
          <TroveTableResults
            activeTab={activeTab}
            collateral={collateral}
            visibleRows={tableRows.visibleRows}
            emptyMessage={tableRows.emptyMessage}
            page={tableRows.clampedPage}
            total={tableRows.filteredRows.length}
            capped={tableRows.activeCapped}
            rankSuppressed={tableRows.rankSuppressed}
            sortKey={activeSort.sortKey}
            sortDir={activeSort.sortDir}
            onSort={handleSort}
            onPageChange={setPage}
          />
        )}
      </div>
    </section>
  );
}

function useTroveTableRows({
  activeTab,
  search,
  page,
  sortKey,
  sortDir,
  openTroves,
  allTroves,
  interestBatches,
}: {
  activeTab: TroveTab;
  search: string;
  page: number;
  sortKey: TroveSortKey;
  sortDir: SortDir;
  openTroves: CdpTrove[];
  allTroves: CdpTrove[];
  interestBatches: CdpInterestBatch[];
}) {
  const batchById = useMemo(
    () =>
      new Map<string, CdpInterestBatch>(
        interestBatches.map((batch) => [batch.id, batch] as const),
      ),
    [interestBatches],
  );
  const openCapped = openTroves.length >= CDP_TROVES_DETAIL_LIMIT;
  const openRows = useMemo(
    () =>
      buildRankedOpenRows(openTroves, batchById, {
        rankingEnabled: !openCapped,
      }),
    [openTroves, batchById, openCapped],
  );
  const historyRows = useMemo(
    () => buildHistoryRows(allTroves, batchById),
    [allTroves, batchById],
  );
  const sourceRows = activeTab === "open" ? openRows : historyRows;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredRows = useMemo(() => {
    if (!normalizedSearch) return sourceRows;
    return sourceRows.filter(({ trove }) =>
      troveMatchesSearch(trove, normalizedSearch),
    );
  }, [normalizedSearch, sourceRows]);
  const sortedRows = useMemo(
    () => sortDisplayRows(filteredRows, activeTab, sortKey, sortDir),
    [filteredRows, activeTab, sortKey, sortDir],
  );
  const totalPages = Math.max(
    1,
    Math.ceil(sortedRows.length / TROVE_PAGE_SIZE),
  );
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const start = (clampedPage - 1) * TROVE_PAGE_SIZE;
  const activeCapped =
    (activeTab === "open" ? openTroves.length : allTroves.length) >=
    CDP_TROVES_DETAIL_LIMIT;
  const emptyMessage = normalizedSearch
    ? "No troves match the active search."
    : activeTab === "open"
      ? "No open troves indexed yet."
      : "No historical troves indexed yet.";

  return {
    sourceRows,
    filteredRows,
    visibleRows: sortedRows.slice(start, start + TROVE_PAGE_SIZE),
    clampedPage,
    activeCapped,
    rankSuppressed: activeTab === "open" && openCapped,
    emptyMessage,
  };
}

function TroveTableHeader({
  activeTab,
  search,
  onSelectTab,
  onSearch,
}: {
  activeTab: TroveTab;
  search: string;
  onSelectTab: (tab: TroveTab) => void;
  onSearch: (value: string) => void;
}) {
  const activeIndex = Math.max(0, TROVE_TABS.indexOf(activeTab));
  const {
    groupRef: tablistRef,
    getItemProps,
    handleKeyDown,
  } = useRovingTabIndex({
    activeIndex,
    itemCount: TROVE_TABS.length,
    activation: "manual",
    arrowKeys: "horizontal",
  });

  return (
    <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <h2 className="text-lg font-semibold text-white">Troves</h2>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div
          ref={tablistRef}
          className="inline-flex rounded-md border border-slate-800 bg-slate-950 p-0.5"
          role="tablist"
          aria-label="Trove views"
          onKeyDown={handleKeyDown}
          tabIndex={-1}
        >
          {TROVE_TABS.map((tab, index) => {
            const rovingProps = getItemProps(index);
            return (
              <TroveTabButton
                key={tab}
                tab={tab}
                active={activeTab === tab}
                tabIndex={rovingProps.tabIndex}
                buttonRef={rovingProps.ref}
                onFocus={rovingProps.onFocus}
                onClick={() => onSelectTab(tab)}
              >
                {tab === "open" ? "Open" : "History"}
              </TroveTabButton>
            );
          })}
        </div>
        <label className="sr-only" htmlFor="cdp-trove-search">
          Search troves
        </label>
        <input
          id="cdp-trove-search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search owner or trove ID"
          className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-muted focus:border-indigo-500 focus:outline-none sm:w-64"
        />
      </div>
    </div>
  );
}

function TroveTableResults({
  activeTab,
  collateral,
  visibleRows,
  emptyMessage,
  page,
  total,
  capped,
  rankSuppressed,
  sortKey,
  sortDir,
  onSort,
  onPageChange,
}: {
  activeTab: TroveTab;
  collateral: CdpCollateral;
  visibleRows: TroveDisplayRow[];
  emptyMessage: string;
  page: number;
  total: number;
  capped: boolean;
  rankSuppressed: boolean;
  sortKey: TroveSortKey;
  sortDir: SortDir;
  onSort: (key: TroveSortKey) => void;
  onPageChange: (page: number) => void;
}) {
  const historyView = activeTab === "history";
  return (
    <>
      <Table
        aria-label={`${collateral.symbol} troves`}
        scrollClassName="xl:overflow-x-clip"
      >
        <thead>
          {historyView ? (
            <HistoryTroveHeader
              sortKey={sortKey as HistorySortKey}
              sortDir={sortDir}
              onSort={onSort}
            />
          ) : (
            <OpenTroveHeader
              sortKey={sortKey as OpenSortKey}
              sortDir={sortDir}
              onSort={onSort}
            />
          )}
        </thead>
        <tbody>
          {visibleRows.length === 0 ? (
            <Row>
              <td
                colSpan={8}
                className="px-2 py-3 text-center text-xs text-muted sm:px-4"
              >
                {emptyMessage}
              </td>
            </Row>
          ) : (
            visibleRows.map((row) => (
              <TroveRow
                key={row.trove.id}
                row={row}
                collateral={collateral}
                view={activeTab}
              />
            ))
          )}
        </tbody>
      </Table>
      <Pagination
        page={page}
        pageSize={TROVE_PAGE_SIZE}
        total={total}
        onPageChange={onPageChange}
      />
      {capped && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing {CDP_TROVES_DETAIL_LIMIT.toLocaleString()} fetched troves for
          this view — search and sorting cover these fetched rows only, not the
          full set.
          {activeTab === "open" && rankSuppressed
            ? " Redemption ranks are hidden because the full open-trove set is not loaded."
            : ""}
        </p>
      )}
    </>
  );
}

function TroveTabButton({
  tab,
  active,
  tabIndex,
  buttonRef,
  onFocus,
  onClick,
  children,
}: {
  tab: TroveTab;
  active: boolean;
  tabIndex: number;
  buttonRef: (node: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      id={troveTabId(tab)}
      aria-selected={active}
      aria-controls={trovePanelId(tab)}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onClick}
      className={[
        "rounded px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-indigo-600 text-white"
          : "text-slate-400 hover:text-slate-200",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
