"use client";

import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useBridgeGQL } from "@/lib/bridge-flows/use-bridge-gql";
import {
  BRIDGE_TRANSFERS_WINDOW,
  BRIDGE_TRANSFERS_COUNT,
  BRIDGE_DAILY_SNAPSHOT,
  BRIDGE_PENDING_IDS,
  BRIDGE_TOP_BRIDGERS,
  BRIDGE_DELIVERED_RECENT,
} from "@/lib/bridge-queries";
import {
  TOP_BRIDGERS_EXPANDED,
  ROUTE_STATS_LIMIT,
} from "@/lib/bridge-flows/layout";
import { ALL_BRIDGE_STATUSES } from "@/lib/bridge-status";
import { BridgeStatusFilter } from "@/components/bridge-status-filter";
import {
  ToastPortal,
  type AddToast,
  type ToastEntry,
} from "@/components/bridge-redeem-cta";
import { Skeleton, ErrorBox, EmptyBox } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { useOracleRates } from "@/hooks/use-oracle-rates";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { windowTotals } from "@/lib/bridge-flows/snapshots";
import { TransfersTable } from "./transfers-table";
import { BridgeOverviewSection } from "./bridge-overview-section";
import type {
  BridgeBridger,
  BridgeDailySnapshot,
  BridgeStatus,
  BridgeTransfer,
} from "@/lib/types";

const PAGE_LIMIT = 25;

type LastKnownTotal = {
  key: string;
  total: number;
};

type BridgeFlowUrlState = {
  rawPage: number;
  selectedStatus: BridgeStatus | null;
  statusIn: BridgeStatus[];
  setPage: (page: number) => void;
  handleStatusChange: (status: BridgeStatus | null) => void;
};

type RecentTransfersSectionProps = {
  selectedStatus: BridgeStatus | null;
  handleStatusChange: (status: BridgeStatus | null) => void;
  transfersResult: ReturnType<
    typeof useBridgeGQL<{ BridgeTransfer: BridgeTransfer[] }>
  >;
  transfers: BridgeTransfer[];
  rates: ReturnType<typeof useOracleRates>["merged"];
  addToast: AddToast;
  page: number;
  total: number;
  setPage: (page: number) => void;
  totalCapped: boolean;
  countHasError: boolean;
};

function updateLastKnownTotal(
  ref: { current: LastKnownTotal },
  key: string,
  rawTotal: number,
): number {
  if (ref.current.key !== key) {
    ref.current = { key, total: 0 };
  }
  if (rawTotal > 0) ref.current.total = rawTotal;
  return ref.current.total;
}

function useBridgeFlowUrlState(): BridgeFlowUrlState {
  const searchParams = useSearchParams();
  const { replace } = useRouter();

  const rawPage = Math.max(
    1,
    // react-doctor-disable-next-line react-doctor/react-compiler-destructure-method
    parseInt(searchParams.get("page") ?? "1", 10) || 1,
  );

  const selectedStatus = useMemo<BridgeStatus | null>(() => {
    // react-doctor-disable-next-line react-doctor/react-compiler-destructure-method
    const param = searchParams.get("status");
    if (param === null) return null;
    const validSet = new Set<string>(ALL_BRIDGE_STATUSES);
    return validSet.has(param) ? (param as BridgeStatus) : null;
  }, [searchParams]);

  const statusIn =
    selectedStatus !== null ? [selectedStatus] : ALL_BRIDGE_STATUSES.slice();

  const setPage = useCallback(
    (p: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (p === 1) params.delete("page");
      else params.set("page", String(p));
      replace(`?${params.toString()}`, { scroll: false });
    },
    [replace, searchParams],
  );

  const handleStatusChange = useCallback(
    (next: BridgeStatus | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === null) params.delete("status");
      else params.set("status", next);
      params.delete("page");
      replace(`?${params.toString()}`, { scroll: false });
    },
    [replace, searchParams],
  );

  return { rawPage, selectedStatus, statusIn, setPage, handleStatusChange };
}

function useBridgeToasts(): [ToastEntry[], AddToast, (id: number) => void] {
  const toastIdRef = useRef(0);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const dismissToast = useCallback(
    (id: number) => setToasts((t) => t.filter((x) => x.id !== id)),
    [],
  );
  const addToast = useCallback<AddToast>(
    (message, type, href) => {
      const id = ++toastIdRef.current;
      setToasts((t) => [...t, { id, message, type, href }]);
      setTimeout(() => dismissToast(id), 6_000);
    },
    [dismissToast],
  );
  return [toasts, addToast, dismissToast];
}

function BridgeFlowsHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-1">Bridge Flows</h1>
      <p className="text-sm text-slate-400">
        Wormhole NTT transfers of Mento stable tokens across Celo and Monad
      </p>
    </div>
  );
}

function RecentTransfersSection({
  selectedStatus,
  handleStatusChange,
  transfersResult,
  transfers,
  rates,
  addToast,
  page,
  total,
  setPage,
  totalCapped,
  countHasError,
}: RecentTransfersSectionProps) {
  return (
    <section aria-label="Recent transfers">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-semibold text-white">Recent transfers</h2>
        <BridgeStatusFilter
          options={ALL_BRIDGE_STATUSES}
          selected={selectedStatus}
          onChange={handleStatusChange}
        />
      </div>
      {transfersResult.error ? (
        <EmptyBox message="Unable to load transfers — see error above." />
      ) : transfersResult.isLoading && transfers.length === 0 ? (
        <Skeleton rows={5} />
      ) : transfers.length === 0 ? (
        <EmptyBox
          message={
            selectedStatus !== null
              ? "No bridge transfers match the selected status."
              : "No bridge transfers yet."
          }
        />
      ) : (
        <>
          <TransfersTable
            transfers={transfers}
            rates={rates}
            addToast={addToast}
          />
          <Pagination
            page={page}
            pageSize={PAGE_LIMIT}
            total={total}
            onPageChange={setPage}
          />
          {totalCapped && (
            <p className="mt-1 text-xs text-slate-500">
              Showing first {ENVIO_MAX_ROWS.toLocaleString()} transfers — older
              entries may exist beyond this page range.
            </p>
          )}
          {countHasError && (
            <p className="mt-1 text-xs text-slate-500">
              Total count degraded — showing last known denominator.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function useBridgePaginationData(
  rawPage: number,
  selectedStatus: BridgeStatus | null,
  statusIn: BridgeStatus[],
) {
  const countResult = useBridgeGQL<{ BridgeTransfer: Array<{ id: string }> }>(
    BRIDGE_TRANSFERS_COUNT,
    {
      statusIn,
      limit: ENVIO_MAX_ROWS,
    },
  );
  const statusKey = selectedStatus ?? "all";
  const lastKnownTotalRef = useRef({ key: statusKey, total: 0 });
  const rawTotal = countResult.data?.BridgeTransfer.length ?? 0;
  const lastKnownTotal = updateLastKnownTotal(
    lastKnownTotalRef,
    statusKey,
    rawTotal,
  );
  const total = countResult.error ? lastKnownTotal : rawTotal;
  const totalCapped = !countResult.error && rawTotal >= ENVIO_MAX_ROWS;
  const totalPages = total > 0 ? Math.ceil(total / PAGE_LIMIT) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));

  const transfersResult = useBridgeGQL<{ BridgeTransfer: BridgeTransfer[] }>(
    BRIDGE_TRANSFERS_WINDOW,
    {
      limit: PAGE_LIMIT,
      offset: (page - 1) * PAGE_LIMIT,
      statusIn,
    },
  );
  return {
    countHasError: !!countResult.error,
    page,
    total,
    totalCapped,
    transfers: transfersResult.data?.BridgeTransfer ?? [],
    transfersResult,
  };
}

function summarizeCappedCount(rowCount: number | null) {
  return {
    capped: rowCount !== null && rowCount >= 1000,
    count: rowCount === null ? null : Math.min(rowCount, 1000),
  };
}

function isLoadingEmpty(isLoading: boolean, rowCount: number) {
  return isLoading && rowCount === 0;
}

function firstErrorMessage(...errors: Array<Error | undefined>) {
  return errors.find(Boolean)?.message ?? null;
}

function useBridgeOverviewData() {
  const snapshotsResult = useBridgeGQL<{
    BridgeDailySnapshot: BridgeDailySnapshot[];
  }>(BRIDGE_DAILY_SNAPSHOT, { afterDate: 0 });
  const pendingResult = useBridgeGQL<{ BridgeTransfer: Array<{ id: string }> }>(
    BRIDGE_PENDING_IDS,
  );
  const topBridgersResult = useBridgeGQL<{ BridgeBridger: BridgeBridger[] }>(
    BRIDGE_TOP_BRIDGERS,
    { limit: TOP_BRIDGERS_EXPANDED },
  );
  const deliveredRecentResult = useBridgeGQL<{
    BridgeTransfer: Array<{
      status: BridgeStatus;
      sentTimestamp: string | null;
      deliveredTimestamp: string | null;
      sourceChainId: number | null;
      destChainId: number | null;
    }>;
  }>(BRIDGE_DELIVERED_RECENT, { limit: ROUTE_STATS_LIMIT });
  const { merged: rates } = useOracleRates();

  const snapshots = snapshotsResult.data?.BridgeDailySnapshot ?? [];
  const topBridgers = topBridgersResult.data?.BridgeBridger ?? [];
  const deliveredTransfers = deliveredRecentResult.data?.BridgeTransfer ?? [];
  const transferTotals = useMemo(
    () => windowTotals(snapshots, (s) => s.sentCount ?? 0),
    [snapshots],
  );
  const pendingRows = pendingResult.data?.BridgeTransfer?.length ?? null;
  const pending = summarizeCappedCount(pendingRows);

  return {
    deliveredHasError: !!deliveredRecentResult.error,
    deliveredIsLoading: isLoadingEmpty(
      deliveredRecentResult.isLoading,
      deliveredTransfers.length,
    ),
    deliveredTransfers,
    error: firstErrorMessage(snapshotsResult.error, pendingResult.error),
    pendingCapped: pending.capped,
    pendingCount: pending.count,
    pendingHasError: !!pendingResult.error,
    rates,
    snapshots,
    snapshotsCapped: snapshots.length >= 1000,
    snapshotsHasError: !!snapshotsResult.error,
    snapshotsIsLoading: isLoadingEmpty(
      snapshotsResult.isLoading,
      snapshots.length,
    ),
    topBridgers,
    topBridgersHasError: !!topBridgersResult.error,
    topBridgersIsLoading: isLoadingEmpty(
      topBridgersResult.isLoading,
      topBridgers.length,
    ),
    transferTotals,
  };
}

export function BridgeFlowsPageClient() {
  return (
    <Suspense>
      <BridgeFlowsContent />
    </Suspense>
  );
}

function BridgeFlowsContent() {
  // Page + status filter are URL-backed so users can refresh, share, or
  // navigate back without losing their view. Pattern mirrors pools/page.tsx
  // and pool/[poolId]/page.tsx. Resetting page to 1 on filter change keeps
  // users out of empty trailing pages. The active `page` is clamped against
  // `totalPages` below to guard against stale indices from count shrinkage.
  const { rawPage, selectedStatus, statusIn, setPage, handleStatusChange } =
    useBridgeFlowUrlState();
  const pagination = useBridgePaginationData(rawPage, selectedStatus, statusIn);
  const overview = useBridgeOverviewData();
  const [toasts, addToast, dismissToast] = useBridgeToasts();
  const error =
    pagination.transfersResult.error?.message ?? overview.error ?? null;

  return (
    <div className="space-y-8">
      <ToastPortal toasts={toasts} onDismiss={dismissToast} />
      <BridgeFlowsHeader />

      {error && <ErrorBox message={error} />}

      <BridgeOverviewSection
        snapshots={overview.snapshots}
        rates={overview.rates}
        snapshotsIsLoading={overview.snapshotsIsLoading}
        snapshotsHasError={overview.snapshotsHasError}
        snapshotsCapped={overview.snapshotsCapped}
        topBridgers={overview.topBridgers}
        topBridgersIsLoading={overview.topBridgersIsLoading}
        topBridgersHasError={overview.topBridgersHasError}
        transferTotals={overview.transferTotals}
        pendingHasError={overview.pendingHasError}
        pendingCount={overview.pendingCount}
        pendingCapped={overview.pendingCapped}
        deliveredTransfers={overview.deliveredTransfers}
        deliveredIsLoading={overview.deliveredIsLoading}
        deliveredHasError={overview.deliveredHasError}
      />

      <RecentTransfersSection
        selectedStatus={selectedStatus}
        handleStatusChange={handleStatusChange}
        transfersResult={pagination.transfersResult}
        transfers={pagination.transfers}
        rates={overview.rates}
        addToast={addToast}
        page={pagination.page}
        total={pagination.total}
        setPage={setPage}
        totalCapped={pagination.totalCapped}
        countHasError={pagination.countHasError}
      />
    </div>
  );
}
