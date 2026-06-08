"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AddressLink } from "@/components/address-link";
import { EmptyBox } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { Table, Row, Th, Td } from "@/components/table";
import { relativeTime } from "@/lib/format";
import { useRovingTabIndex } from "@/lib/use-roving-tab-index";
import {
  CDP_TROVES_DETAIL_LIMIT,
  type CdpCollateral,
  type CdpInterestBatch,
  type CdpTrove,
} from "../../_lib/types";
import { formatTokenAmount } from "../../_lib/format";

const TROVE_TABS = ["open", "history"] as const;

type TroveTab = (typeof TROVE_TABS)[number];

type TroveDisplayRow = {
  trove: CdpTrove;
  effectiveRate: bigint | null;
  rank: number | null;
  tied: boolean;
  rateSource: "direct" | "batch" | null;
};

const TROVE_PAGE_SIZE = 25;
const D18 = BigInt(10) ** BigInt(18);

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
  const tableRows = useTroveTableRows({
    activeTab,
    search,
    page,
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
            collateral={collateral}
            visibleRows={tableRows.visibleRows}
            emptyMessage={tableRows.emptyMessage}
            page={tableRows.clampedPage}
            total={tableRows.filteredRows.length}
            capped={tableRows.activeCapped}
            rankSuppressed={tableRows.rankSuppressed}
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
  openTroves,
  allTroves,
  interestBatches,
}: {
  activeTab: TroveTab;
  search: string;
  page: number;
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
  const rankByTroveId = useMemo(
    () =>
      new Map<string, TroveDisplayRow>(
        openRows.map((row) => [row.trove.id, row] as const),
      ),
    [openRows],
  );
  const historyRows = useMemo(
    () => buildHistoryRows(allTroves, batchById, rankByTroveId),
    [allTroves, batchById, rankByTroveId],
  );
  const sourceRows = activeTab === "open" ? openRows : historyRows;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredRows = useMemo(() => {
    if (!normalizedSearch) return sourceRows;
    return sourceRows.filter(({ trove }) =>
      troveMatchesSearch(trove, normalizedSearch),
    );
  }, [normalizedSearch, sourceRows]);
  const totalPages = Math.max(
    1,
    Math.ceil(filteredRows.length / TROVE_PAGE_SIZE),
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
      : "No troves indexed yet.";

  return {
    sourceRows,
    filteredRows,
    visibleRows: filteredRows.slice(start, start + TROVE_PAGE_SIZE),
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
  collateral,
  visibleRows,
  emptyMessage,
  page,
  total,
  capped,
  rankSuppressed,
  onPageChange,
}: {
  collateral: CdpCollateral;
  visibleRows: TroveDisplayRow[];
  emptyMessage: string;
  page: number;
  total: number;
  capped: boolean;
  rankSuppressed: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <>
      <Table aria-label={`${collateral.symbol} troves`}>
        <thead>
          <Row>
            <Th align="right">Rank</Th>
            <Th>Owner / Trove</Th>
            <Th>Status</Th>
            <Th align="right">Debt</Th>
            <Th align="right">Collateral</Th>
            <Th align="right">ICR (indexed)</Th>
            <Th align="right">Interest</Th>
            <Th align="right">Updated</Th>
          </Row>
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
              <TroveRow key={row.trove.id} row={row} collateral={collateral} />
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
          this view — search covers fetched rows only.
          {rankSuppressed
            ? " Redemption ranks are hidden because the full open-trove set is not loaded."
            : " Ranks cover fetched rows only."}
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
}: {
  row: TroveDisplayRow;
  collateral: CdpCollateral;
}) {
  const { trove } = row;
  return (
    <Row>
      <Td align="right">
        <RankValue row={row} />
      </Td>
      <Td>
        <div className="flex flex-col gap-0.5">
          <AddressLink address={trove.owner} chainId={collateral.chainId} />
          <span className="font-mono text-[10px] text-slate-500">
            #{trove.troveId}
          </span>
        </div>
      </Td>
      <Td>{trove.status}</Td>
      <Td align="right">{formatTokenAmount(trove.debt, collateral.symbol)}</Td>
      <Td align="right">{formatTokenAmount(trove.coll, "USDm")}</Td>
      <Td align="right">
        <span className={icrTextClass(trove.icrBps, collateral.mcrBps)}>
          {formatBpsPercent(trove.icrBps)}
        </span>
      </Td>
      <Td align="right">
        <InterestValue row={row} />
      </Td>
      <Td align="right">{relativeTime(trove.lastUpdatedAt)}</Td>
    </Row>
  );
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
  rankedOpenById: ReadonlyMap<string, TroveDisplayRow>,
): TroveDisplayRow[] {
  return troves.map((trove) => {
    const ranked = rankedOpenById.get(trove.id);
    if (ranked != null) return ranked;
    return displayRowForTrove(trove, batchById, {
      useStoredBatchRate: true,
    });
  });
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

function compareRedemptionPriorityRows(
  a: TroveDisplayRow,
  b: TroveDisplayRow,
): number {
  const rate = compareNullableBigInt(a.effectiveRate, b.effectiveRate);
  if (rate !== 0) return rate;
  const troveId = compareNumericStrings(a.trove.troveId, b.trove.troveId);
  if (troveId !== 0) return troveId;
  return a.trove.id.localeCompare(b.trove.id);
}

function compareNullableBigInt(a: bigint | null, b: bigint | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNumericStrings(a: string, b: string): number {
  const parsedA = parseBigInt(a);
  const parsedB = parseBigInt(b);
  if (parsedA != null && parsedB != null) {
    if (parsedA < parsedB) return -1;
    if (parsedA > parsedB) return 1;
    return 0;
  }
  return a.localeCompare(b);
}

function parseBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function troveMatchesSearch(
  trove: CdpTrove,
  normalizedSearch: string,
): boolean {
  return (
    trove.owner.toLowerCase().includes(normalizedSearch) ||
    trove.troveId.toLowerCase().includes(normalizedSearch) ||
    trove.id.toLowerCase().includes(normalizedSearch)
  );
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
