"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AddressLink } from "@/components/address-link";
import { EmptyBox } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { Table, Row, Td } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { NETWORKS, networkIdForChainId } from "@/lib/networks";
import type { SortDir } from "@/lib/table-sort";
import { explorerTxUrl } from "@/lib/tokens";
import { useRovingTabIndex } from "@/lib/use-roving-tab-index";
import { useTableSort } from "@/lib/use-table-sort";
import {
  CDP_TROVE_OPEN_STATUSES,
  CDP_TROVES_DETAIL_LIMIT,
  type CdpCollateral,
  type CdpInterestBatch,
  type CdpTrove,
} from "../../_lib/types";
import { formatTokenAmount } from "../../_lib/format";
import { HistoryTroveHeader, OpenTroveHeader } from "./trove-table-headers";
import {
  compareRedemptionPriorityRows,
  HISTORY_SORT_DEFAULT_DIR,
  HISTORY_SORT_DEFAULT_KEY,
  HISTORY_SORT_KEYS,
  OPEN_SORT_DEFAULT_DIR,
  OPEN_SORT_DEFAULT_KEY,
  OPEN_SORT_KEYS,
  parseBigInt,
  sortDisplayRows,
  type HistorySortKey,
  type OpenSortKey,
  type TroveDisplayRow,
  type TroveSortKey,
} from "./trove-sort";

const TROVE_TABS = ["open", "history"] as const;

type TroveTab = (typeof TROVE_TABS)[number];

const TROVE_PAGE_SIZE = 25;
const D18 = BigInt(10) ** BigInt(18);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MENTO_APP_BORROW_MANAGE_BASE_URL = "https://app.mento.org/borrow/manage";

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
          className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none sm:w-64"
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
                className="px-2 py-3 text-center text-xs text-slate-500 sm:px-4"
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

function TroveRow({
  row,
  collateral,
  view,
}: {
  row: TroveDisplayRow;
  collateral: CdpCollateral;
  view: TroveTab;
}) {
  if (view === "history") {
    return <HistoryTroveRow row={row} collateral={collateral} />;
  }
  return <OpenTroveRow row={row} collateral={collateral} />;
}

function OpenTroveRow({
  row,
  collateral,
}: {
  row: TroveDisplayRow;
  collateral: CdpCollateral;
}) {
  const { trove } = row;
  const icrTimestamp = formatTimestamp(trove.lastUpdatedAt);
  const icrTitle =
    trove.icrBps < 0
      ? `Indexed ICR unavailable. Row last updated at ${icrTimestamp}.`
      : `Indexed ICR as of ${icrTimestamp}.\nNot a live RPC or oracle read.`;
  return (
    <Row>
      <Td align="right">
        <RankValue row={row} />
      </Td>
      <Td>
        <OwnerTroveCell trove={trove} collateral={collateral} />
      </Td>
      <Td>{trove.status}</Td>
      <Td align="right">{formatTokenAmount(trove.debt, collateral.symbol)}</Td>
      <Td align="right">{formatTokenAmount(trove.coll, "USDm")}</Td>
      <Td align="right">
        <Tooltip content={icrTitle} align="right">
          <span className={icrTextClass(trove.icrBps, collateral.mcrBps)}>
            {formatBpsPercent(trove.icrBps)}
          </span>
        </Tooltip>
      </Td>
      <Td align="right">
        <InterestValue row={row} />
      </Td>
      <Td align="right">
        <UpdatedValue trove={trove} chainId={collateral.chainId} />
      </Td>
    </Row>
  );
}

function HistoryTroveRow({
  row,
  collateral,
}: {
  row: TroveDisplayRow;
  collateral: CdpCollateral;
}) {
  const { trove } = row;
  const endedAt = trove.closedAt ?? trove.lastUpdatedAt;
  const endedTxHash = trove.closedTxHash ?? trove.lastUpdatedTxHash ?? null;
  return (
    <Row>
      <Td>
        <OwnerTroveCell trove={trove} collateral={collateral} useLastOwner />
      </Td>
      <Td>{trove.status}</Td>
      <Td align="right">
        <EventTimeValue
          timestamp={trove.openedAt}
          txHash={trove.openedTxHash}
          chainId={collateral.chainId}
          prefix="Opened at"
        />
      </Td>
      <Td align="right">
        <EventTimeValue
          timestamp={endedAt}
          txHash={endedTxHash}
          chainId={collateral.chainId}
          prefix={trove.closedAt == null ? "Updated at" : "Ended at"}
        />
      </Td>
      <Td align="right">{formatTokenAmount(trove.coll, "USDm")}</Td>
      <Td align="right">
        <RedeemedValue trove={trove} symbol={collateral.symbol} />
      </Td>
      <Td align="right">
        <OutcomeAmount value={trove.redemptionFeePaidCum} symbol="USDm" />
      </Td>
      <Td align="right">
        <LiquidatedValue trove={trove} symbol={collateral.symbol} />
      </Td>
    </Row>
  );
}

function OwnerTroveCell({
  trove,
  collateral,
  useLastOwner = false,
}: {
  trove: CdpTrove;
  collateral: CdpCollateral;
  useLastOwner?: boolean;
}) {
  const owner = useLastOwner ? lastOwnerAddress(trove) : trove.owner;
  return (
    <div className="flex flex-col gap-0.5">
      <AddressLink address={owner} chainId={collateral.chainId} />
      <a
        href={troveManageUrl(trove.troveId, collateral.symbol)}
        target="_blank"
        rel="noopener noreferrer"
        title={trove.troveId}
        aria-label={`Manage trove ${trove.troveId} in the Mento app`}
        className="font-mono text-[10px] text-slate-500 hover:text-slate-300 hover:underline focus:outline-none focus:ring-1 focus:ring-indigo-500"
      >
        {shortenTroveId(trove.troveId)}
      </a>
    </div>
  );
}

/**
 * Trove IDs are uint256 token ids (often a 66-char `0x…` hash). Rendering them
 * in full blew the first column out past the viewport (horizontal scroll);
 * middle-ellipsize for display while keeping the full id in the link + title.
 */
function shortenTroveId(troveId: string): string {
  return troveId.length <= 13
    ? troveId
    : `${troveId.slice(0, 6)}…${troveId.slice(-4)}`;
}

function RankValue({ row }: { row: TroveDisplayRow }) {
  if (row.rank == null) return <span className="text-slate-500">—</span>;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>#{row.rank.toLocaleString()}</span>
      {row.tied && <span className="text-[10px] text-slate-500">tie</span>}
    </span>
  );
}

function InterestValue({ row }: { row: TroveDisplayRow }) {
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{formatInterestRate(row.effectiveRate)}</span>
      {row.rateSource === "batch" && (
        <span className="text-[10px] text-slate-500">Batch</span>
      )}
      {row.rateSource == null && row.trove.interestBatchId != null && (
        <span className="text-[10px] text-amber-400">Batch missing</span>
      )}
    </span>
  );
}

function EventTimeValue({
  timestamp,
  txHash,
  chainId,
  prefix,
}: {
  timestamp: string | null | undefined;
  txHash: string | null | undefined;
  chainId: number;
  prefix: string;
}) {
  if (!timestamp || timestamp === "0") {
    return <span className="text-slate-500">—</span>;
  }

  const label = relativeTime(timestamp);
  const exact = formatTimestamp(timestamp);
  if (!txHash) {
    return (
      <Tooltip content={`${prefix} ${exact}.`} align="right">
        <span className="text-slate-300">{label}</span>
      </Tooltip>
    );
  }

  const networkId = networkIdForChainId(chainId);
  const network = networkId ? NETWORKS[networkId] : null;
  if (network == null) {
    return (
      <Tooltip
        content={`${prefix} ${exact}. Transaction: ${txHash}.`}
        align="right"
      >
        <span className="text-slate-300">{label}</span>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={`${prefix} ${exact}. Opens transaction ${txHash}.`}
      align="right"
      asChild
    >
      <a
        href={explorerTxUrl(network, txHash)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-slate-300 transition-colors hover:text-indigo-300"
      >
        {label}
      </a>
    </Tooltip>
  );
}

function RedeemedValue({ trove, symbol }: { trove: CdpTrove; symbol: string }) {
  if (
    !isPositiveWei(trove.redeemedDebt) &&
    !isPositiveWei(trove.redeemedColl) &&
    trove.redemptionCount === 0
  ) {
    return <span className="text-slate-500">—</span>;
  }
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{formatTokenAmount(trove.redeemedDebt, symbol)}</span>
      <span className="text-[10px] text-slate-500">
        {trove.redemptionCount.toLocaleString()}{" "}
        {trove.redemptionCount === 1 ? "event" : "events"}
      </span>
    </span>
  );
}

function OutcomeAmount({
  value,
  symbol,
}: {
  value: string | null | undefined;
  symbol: string;
}) {
  if (!isPositiveWei(value)) return <span className="text-slate-500">—</span>;
  return <span>{formatTokenAmount(value, symbol)}</span>;
}

function LiquidatedValue({
  trove,
  symbol,
}: {
  trove: CdpTrove;
  symbol: string;
}) {
  if (
    !isPositiveWei(trove.liquidatedDebt) &&
    !isPositiveWei(trove.liquidatedColl)
  ) {
    return <span className="text-slate-500">—</span>;
  }
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{formatTokenAmount(trove.liquidatedDebt, symbol)}</span>
      {isPositiveWei(trove.liquidatedColl) && (
        <span className="text-[10px] text-slate-500">
          {formatTokenAmount(trove.liquidatedColl, "USDm")}
        </span>
      )}
    </span>
  );
}

function UpdatedValue({
  trove,
  chainId,
}: {
  trove: CdpTrove;
  chainId: number;
}) {
  const label = relativeTime(trove.lastUpdatedAt);
  const timestamp = formatTimestamp(trove.lastUpdatedAt);
  const networkId = networkIdForChainId(chainId);
  const network = networkId ? NETWORKS[networkId] : null;
  // Deliberately a plain link, not a Tooltip (unlike EventTimeValue on the
  // History tab): the relative time is already clickable, so the popover was
  // just noise. The exact timestamp + destination are exposed to assistive tech
  // via real sr-only text (a native title or aria-label on a non-interactive
  // span isn't reliably announced) and to sighted users via the title.
  if (trove.lastUpdatedTxHash && network != null) {
    return (
      <a
        href={explorerTxUrl(network, trove.lastUpdatedTxHash)}
        target="_blank"
        rel="noopener noreferrer"
        title={`Updated at ${timestamp}`}
        className="font-mono text-slate-300 transition-colors hover:text-indigo-300"
      >
        {label}
        <span className="sr-only">
          , updated at {timestamp}, opens transaction
        </span>
      </a>
    );
  }

  // No linkable explorer for this chain: still disclose the tx hash in the
  // title when one exists (mirrors EventTimeValue's no-explorer fallback) so it
  // isn't silently dropped.
  const fallbackTitle = trove.lastUpdatedTxHash
    ? `Updated at ${timestamp} · tx ${trove.lastUpdatedTxHash}`
    : `Updated at ${timestamp}`;
  return (
    <span className="text-slate-300" title={fallbackTitle}>
      {label}
      <span className="sr-only">, updated at {timestamp}</span>
    </span>
  );
}

function buildRankedOpenRows(
  troves: CdpTrove[],
  batchById: ReadonlyMap<string, CdpInterestBatch>,
  { rankingEnabled = true }: { rankingEnabled?: boolean } = {},
): TroveDisplayRow[] {
  const rows = troves.map((trove) => displayRowForTrove(trove, batchById));
  rows.sort(compareRedemptionPriorityRows);
  if (!rankingEnabled) return rows;
  const rateCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.effectiveRate == null) continue;
    const key = row.effectiveRate.toString();
    rateCounts.set(key, (rateCounts.get(key) ?? 0) + 1);
  }

  let currentRank = 0;
  let previousRate: string | null = null;
  return rows.map((row) => {
    if (row.effectiveRate == null) return row;
    const rate = row.effectiveRate.toString();
    if (rate !== previousRate) {
      currentRank += 1;
      previousRate = rate;
    }
    return {
      ...row,
      rank: currentRank,
      tied: (rateCounts.get(rate) ?? 0) > 1,
    };
  });
}

function buildHistoryRows(
  troves: CdpTrove[],
  batchById: ReadonlyMap<string, CdpInterestBatch>,
): TroveDisplayRow[] {
  const rows: TroveDisplayRow[] = [];
  for (const trove of troves) {
    if (isOpenTroveStatus(trove.status)) continue;
    rows.push(
      displayRowForTrove(trove, batchById, {
        useStoredBatchRate: true,
      }),
    );
  }
  return rows;
}

function isOpenTroveStatus(status: string): boolean {
  return (CDP_TROVE_OPEN_STATUSES as readonly string[]).includes(status);
}

function displayRowForTrove(
  trove: CdpTrove,
  batchById: ReadonlyMap<string, CdpInterestBatch>,
  { useStoredBatchRate = false }: { useStoredBatchRate?: boolean } = {},
): TroveDisplayRow {
  if (trove.interestBatchId != null && !useStoredBatchRate) {
    const batch = batchById.get(trove.interestBatchId);
    if (batch == null) {
      return {
        trove,
        effectiveRate: null,
        rank: null,
        tied: false,
        rateSource: null,
      };
    }
    return {
      trove,
      effectiveRate: parseBigInt(batch.annualInterestRate),
      rank: null,
      tied: false,
      rateSource: "batch",
    };
  }

  const directRate = parseBigInt(trove.interestRate);
  return {
    trove,
    effectiveRate: directRate,
    rank: null,
    tied: false,
    rateSource: directRate != null ? "direct" : null,
  };
}

function troveManageUrl(troveId: string, tokenSymbol: string): string {
  return `${MENTO_APP_BORROW_MANAGE_BASE_URL}/${encodeURIComponent(
    troveId,
  )}?token=${encodeURIComponent(tokenSymbol)}`;
}

function troveMatchesSearch(
  trove: CdpTrove,
  normalizedSearch: string,
): boolean {
  return (
    trove.owner.toLowerCase().includes(normalizedSearch) ||
    trove.previousOwner.toLowerCase().includes(normalizedSearch) ||
    trove.troveId.toLowerCase().includes(normalizedSearch) ||
    trove.id.toLowerCase().includes(normalizedSearch)
  );
}

function lastOwnerAddress(trove: CdpTrove): string {
  if (isZeroAddress(trove.owner) && !isZeroAddress(trove.previousOwner)) {
    return trove.previousOwner;
  }
  return trove.owner;
}

function isZeroAddress(address: string | null | undefined): boolean {
  return address?.toLowerCase() === ZERO_ADDRESS;
}

function isPositiveWei(value: string | null | undefined): boolean {
  if (value == null) return false;
  try {
    return BigInt(value) > BigInt(0);
  } catch {
    return false;
  }
}

function formatInterestRate(rate: bigint | null): string {
  if (rate == null) return "—";
  if (rate === BigInt(0)) return "0.00%";
  const hundredths = (rate * BigInt(10_000)) / D18;
  if (hundredths === BigInt(0)) return "<0.01%";
  return `${(Number(hundredths) / 100).toFixed(2)}%`;
}

function formatBpsPercent(bps: number): string {
  if (bps < 0) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

function icrTextClass(icrBps: number, mcrBps: number): string {
  if (icrBps < 0 || mcrBps <= 0) return "text-slate-500";
  if (icrBps < mcrBps) return "text-rose-300";
  if (icrBps < Math.ceil(mcrBps * 1.2)) return "text-amber-300";
  return "text-emerald-300";
}
