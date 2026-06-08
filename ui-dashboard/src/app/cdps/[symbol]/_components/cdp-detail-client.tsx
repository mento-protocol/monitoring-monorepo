"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { AddressLink } from "@/components/address-link";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, Skeleton, Tile } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { Table, Row, Th, Td } from "@/components/table";
import { useGQL } from "@/lib/graphql";
import {
  CDP_INSTANCE_DAILY_SNAPSHOTS,
  CDP_MARKET_DETAIL,
  CDP_MARKETS,
} from "@/lib/queries";
import { buildPoolDetailHref } from "@/lib/routing";
import { formatWei, relativeTime, truncateAddress } from "@/lib/format";
import type { Network } from "@/lib/networks";
import { explorerAddressUrl } from "@/lib/tokens";
import {
  CDP_TROVES_DETAIL_LIMIT,
  type CdpCollateral,
  type CdpDepositor,
  type CdpInterestBatch,
  type CdpInstance,
  type CdpInstanceDailySnapshot,
  type CdpPoolRow,
  type CdpTrove,
  type CdpTroveListRow,
} from "../../_lib/types";
import {
  cdpSymbolSlug,
  formatTokenAmount,
  redemptionEventSubtitle,
} from "../../_lib/format";
import { aggregateTroves, deriveCdpHealth } from "../../_lib/health";
import { CdpHealthBadge } from "../../_components/cdp-health-badge";
import { CdpStabilityPoolTvlChart } from "./cdp-stability-pool-tvl-chart";
import { CdpTransactionsTable } from "./cdp-transactions-table";

type CdpMarketsResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
  Trove: CdpTroveListRow[];
};

type CdpDetailResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
  OpenTrove: CdpTrove[];
  AllTrove: CdpTrove[];
  InterestBatch: CdpInterestBatch[];
  StabilityPoolDepositor: CdpDepositor[];
  CdpPool: CdpPoolRow[];
};

type CdpDailySnapshotsResponse = {
  LiquityInstanceDailySnapshot: CdpInstanceDailySnapshot[];
};

const TROVE_PAGE_SIZE = 25;
const D18 = BigInt(10) ** BigInt(18);

export function CdpDetailClient({ symbol }: { symbol: string }) {
  const { network } = useNetwork();
  const symbolSlug = cdpSymbolSlug(symbol);
  const markets = useGQL<CdpMarketsResponse>(
    network.chainId === 42220 ? CDP_MARKETS : null,
    { chainId: network.chainId },
  );
  const collateral = useMemo(
    () =>
      (markets.data?.LiquityCollateral ?? []).find(
        (row) => cdpSymbolSlug(row.symbol) === symbolSlug,
      ),
    [markets.data, symbolSlug],
  );
  const detail = useGQL<CdpDetailResponse>(
    collateral == null ? null : CDP_MARKET_DETAIL,
    collateral == null ? undefined : { collateralId: collateral.id },
  );
  const snapshots = useGQL<CdpDailySnapshotsResponse>(
    collateral == null ? null : CDP_INSTANCE_DAILY_SNAPSHOTS,
    collateral == null ? undefined : { instanceId: collateral.id },
  );

  if (network.chainId !== 42220) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }
  return (
    <CdpDetailState
      markets={markets}
      detail={detail}
      snapshots={snapshots}
      collateral={collateral}
      network={network}
    />
  );
}

function CdpDetailState({
  markets,
  detail,
  snapshots,
  collateral,
  network,
}: {
  markets: ReturnType<typeof useGQL<CdpMarketsResponse>>;
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>;
  snapshots: ReturnType<typeof useGQL<CdpDailySnapshotsResponse>>;
  collateral: CdpCollateral | undefined;
  network: Network;
}) {
  if (markets.isLoading || (collateral != null && detail.isLoading)) {
    return <Skeleton rows={8} />;
  }
  if (markets.error) {
    return (
      <ErrorBox
        message={`Failed to load CDP markets — ${markets.error.message}`}
      />
    );
  }
  if (collateral == null) {
    return <EmptyBox message="Unknown CDP market." />;
  }
  if (detail.error) {
    return (
      <ErrorBox
        message={`Failed to load CDP market — ${detail.error.message}`}
      />
    );
  }
  return (
    <CdpDetailContent
      {...buildContentProps({
        detail,
        snapshots,
        collateral,
        network,
      })}
    />
  );
}

function buildContentProps({
  detail,
  snapshots,
  collateral,
  network,
}: {
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>;
  snapshots: ReturnType<typeof useGQL<CdpDailySnapshotsResponse>>;
  collateral: CdpCollateral;
  network: Network;
}) {
  const openTroves = detail.data?.OpenTrove ?? [];
  return {
    collateral,
    instance: detail.data?.LiquityInstance[0],
    openTroves,
    allTroves: detail.data?.AllTrove ?? [],
    interestBatches: detail.data?.InterestBatch ?? [],
    depositors: detail.data?.StabilityPoolDepositor ?? [],
    cdpPools: detail.data?.CdpPool ?? [],
    aggregates: aggregateTroves(openTroves, {
      truncated: openTroves.length >= CDP_TROVES_DETAIL_LIMIT,
    }),
    snapshots: snapshots.data?.LiquityInstanceDailySnapshot ?? [],
    snapshotsLoading: snapshots.isLoading,
    snapshotsError: snapshots.error != null,
    network,
  };
}

function CdpDetailContent({
  collateral,
  instance,
  openTroves,
  allTroves,
  interestBatches,
  depositors,
  cdpPools,
  aggregates,
  snapshots,
  snapshotsLoading,
  snapshotsError,
  network,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
  openTroves: CdpTrove[];
  allTroves: CdpTrove[];
  interestBatches: CdpInterestBatch[];
  depositors: CdpDepositor[];
  cdpPools: CdpPoolRow[];
  aggregates: ReturnType<typeof aggregateTroves>;
  snapshots: CdpInstanceDailySnapshot[];
  snapshotsLoading: boolean;
  snapshotsError: boolean;
  network: Network;
}) {
  return (
    <div className="space-y-8">
      <DetailHeader collateral={collateral} instance={instance} />

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="Total Supply (System Debt)"
          value={formatTokenAmount(instance?.systemDebt, collateral.symbol)}
        />
        <Tile
          label="System Collateral"
          value={formatTokenAmount(instance?.systemColl, "USDm")}
        />
        <Tile
          label="Stability Pool"
          value={formatTokenAmount(instance?.spDeposits, collateral.symbol)}
          href={explorerAddressUrl(network, collateral.stabilityPool)}
        />
        <Tile
          label="Open Troves"
          value={
            instance == null
              ? "—"
              : `${aggregates.truncated ? "≥" : ""}${aggregates.openTroveCount}`
          }
          subtitle={
            aggregates.truncated
              ? "Trove list truncated"
              : `Updated ${relativeTime(instance?.lastEventTimestamp ?? "0")}`
          }
        />
      </section>

      <RedemptionsSection instance={instance} symbol={collateral.symbol} />

      <CdpStabilityPoolTvlChart
        snapshots={snapshots}
        currentSpDeposits={instance?.spDeposits}
        symbol={collateral.symbol}
        isLoading={snapshotsLoading}
        hasError={snapshotsError}
      />

      <TroveTable
        openTroves={openTroves}
        allTroves={allTroves}
        interestBatches={interestBatches}
        collateral={collateral}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DepositorTable
          depositors={depositors}
          symbol={collateral.symbol}
          chainId={collateral.chainId}
        />
        <CdpPoolsTable cdpPools={cdpPools} />
      </section>

      <CdpTransactionsTable
        instanceId={collateral.id}
        chainId={collateral.chainId}
        symbol={collateral.symbol}
      />
    </div>
  );
}

function DetailHeader({
  collateral,
  instance,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
}) {
  const health = deriveCdpHealth(collateral, instance);
  return (
    <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <Link
          href="/cdps"
          className="text-sm text-indigo-400 hover:text-indigo-300"
        >
          CDPs
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-white">
          {collateral.symbol} CDP Market
        </h1>
      </div>
      <div className="flex flex-col items-end gap-1">
        <CdpHealthBadge health={health} />
        <span className="text-xs text-slate-500">
          Last event {relativeTime(instance?.lastEventTimestamp ?? "0")}
        </span>
      </div>
    </header>
  );
}

/** Total / User / Rebalance redemption KPI tiles. The indexer (post-commit
 * 026c629) tracks the rebalance subset separately via `tx.to ==
 * cdpLiquidityStrategy`; user-driven = total − rebalance. */
function RedemptionsSection({
  instance,
  symbol,
}: {
  instance: CdpInstance | undefined;
  symbol: string;
}) {
  // When `instance` is undefined (no LiquityInstance row indexed yet for this
  // collateral, or a transient query gap), every tile renders `—` for both
  // amount and event-count — never a happy-path "0 events".
  const totalCount = instance?.redemptionCountCum;
  const rebalanceCount = instance?.rebalanceRedemptionCountCum;
  const userCount =
    totalCount != null && rebalanceCount != null
      ? Math.max(0, totalCount - rebalanceCount)
      : null;
  const totalDebt = instance?.redemptionDebtCum ?? null;
  const rebalanceDebt = instance?.rebalanceRedemptionDebtCum ?? null;
  // Clamp the subtraction to 0 to mirror `userCount`'s Math.max(0, ...) —
  // defensive consistency. The indexer writes both counters in a single
  // LiquityInstance.set call so rebalance > total isn't a live race today.
  let userDebt: string | null = null;
  if (totalDebt != null && rebalanceDebt != null) {
    const diff = BigInt(totalDebt) - BigInt(rebalanceDebt);
    userDebt = diff < BigInt(0) ? "0" : diff.toString();
  }
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">Redemptions</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile
          label="Total Redemptions"
          value={formatTokenAmount(totalDebt, symbol)}
          subtitle={redemptionEventSubtitle(totalCount)}
        />
        <Tile
          label="User Redemptions"
          value={formatTokenAmount(userDebt, symbol)}
          subtitle={redemptionEventSubtitle(userCount)}
        />
        <Tile
          label="Rebalance Redemptions"
          value={formatTokenAmount(rebalanceDebt, symbol)}
          subtitle={redemptionEventSubtitle(rebalanceCount)}
        />
      </div>
    </section>
  );
}

function CdpPoolsTable({ cdpPools }: { cdpPools: CdpPoolRow[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">CDP Pools</h2>
      {cdpPools.length === 0 ? (
        <EmptyBox message="No active FPMM pools linked to this CDP market." />
      ) : (
        <Table>
          <thead>
            <Row>
              <Th>Pool</Th>
              <Th align="right">Cooldown</Th>
              <Th align="right">Updated</Th>
            </Row>
          </thead>
          <tbody>
            {cdpPools.map((pool) => (
              <Row key={pool.id}>
                <Td mono>
                  <Link
                    href={buildPoolDetailHref(pool.poolId)}
                    className="text-indigo-400 hover:text-indigo-300"
                  >
                    {truncateAddress(pool.poolId)}
                  </Link>
                </Td>
                <Td align="right">{pool.rebalanceCooldownSec}s</Td>
                <Td align="right">{relativeTime(pool.updatedAtTimestamp)}</Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

type TroveTab = "open" | "history";

type TroveDisplayRow = {
  trove: CdpTrove;
  effectiveRate: bigint | null;
  rank: number | null;
  tied: boolean;
  rateSource: "direct" | "batch" | null;
};

function TroveTable({
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
  const batchById = useMemo(
    () =>
      new Map<string, CdpInterestBatch>(
        interestBatches.map((batch) => [batch.id, batch] as const),
      ),
    [interestBatches],
  );
  const openRows = useMemo(
    () => buildRankedOpenRows(openTroves, batchById),
    [openTroves, batchById],
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
  const visibleRows = filteredRows.slice(start, start + TROVE_PAGE_SIZE);
  const activeCapped =
    (activeTab === "open" ? openTroves.length : allTroves.length) >=
    CDP_TROVES_DETAIL_LIMIT;
  const emptyMessage = normalizedSearch
    ? "No troves match the active search."
    : activeTab === "open"
      ? "No open troves indexed yet."
      : "No troves indexed yet.";

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
      {sourceRows.length === 0 ? (
        <EmptyBox message={emptyMessage} />
      ) : (
        <TroveTableResults
          collateral={collateral}
          visibleRows={visibleRows}
          emptyMessage={emptyMessage}
          page={clampedPage}
          total={filteredRows.length}
          capped={activeCapped}
          onPageChange={setPage}
        />
      )}
    </section>
  );
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
  return (
    <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <h2 className="text-lg font-semibold text-white">Troves</h2>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="inline-flex rounded-md border border-slate-800 bg-slate-950 p-0.5">
          <TroveTabButton
            active={activeTab === "open"}
            onClick={() => onSelectTab("open")}
          >
            Open
          </TroveTabButton>
          <TroveTabButton
            active={activeTab === "history"}
            onClick={() => onSelectTab("history")}
          >
            History
          </TroveTabButton>
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
  onPageChange,
}: {
  collateral: CdpCollateral;
  visibleRows: TroveDisplayRow[];
  emptyMessage: string;
  page: number;
  total: number;
  capped: boolean;
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
          this view — search and rank cover fetched rows only.
        </p>
      )}
    </>
  );
}

function TroveTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
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
): TroveDisplayRow[] {
  const rows = troves.map((trove) => displayRowForTrove(trove, batchById));
  rows.sort(compareRedemptionPriorityRows);
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
    return displayRowForTrove(trove, batchById);
  });
}

function displayRowForTrove(
  trove: CdpTrove,
  batchById: ReadonlyMap<string, CdpInterestBatch>,
): TroveDisplayRow {
  const batch =
    trove.interestBatchId == null
      ? undefined
      : batchById.get(trove.interestBatchId);
  const batchRate =
    batch == null ? null : parseBigInt(batch.annualInterestRate);
  const directRate = parseBigInt(trove.interestRate);
  return {
    trove,
    effectiveRate: batchRate ?? directRate,
    rank: null,
    tied: false,
    rateSource:
      batchRate != null ? "batch" : directRate != null ? "direct" : null,
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

function DepositorTable({
  depositors,
  symbol,
  chainId,
}: {
  depositors: CdpDepositor[];
  symbol: string;
  chainId: number;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        Last-Touched Depositors
      </h2>
      {depositors.length === 0 ? (
        <EmptyBox message="No stability pool depositors indexed yet." />
      ) : (
        <Table>
          <thead>
            <Row>
              <Th>Depositor</Th>
              <Th align="right">Deposit</Th>
              <Th align="right">Stashed Coll</Th>
              <Th align="right">Updated</Th>
            </Row>
          </thead>
          <tbody>
            {depositors.map((depositor) => (
              <Row key={depositor.id}>
                <Td>
                  <AddressLink address={depositor.address} chainId={chainId} />
                </Td>
                <Td align="right">
                  {formatTokenAmount(depositor.lastTouchedDeposit, symbol)}
                </Td>
                <Td align="right">
                  {formatWei(depositor.stashedColl, 18, 2)} USDm
                </Td>
                <Td align="right">{relativeTime(depositor.lastUpdatedAt)}</Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
