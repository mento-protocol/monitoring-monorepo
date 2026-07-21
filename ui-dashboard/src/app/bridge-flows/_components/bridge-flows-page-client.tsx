"use client";

import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useBridgeGQL } from "@/lib/bridge-flows/use-bridge-gql";
import {
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
import { windowTotals } from "@/lib/bridge-flows/snapshots";
import { hasErrorWithoutData } from "@/lib/swr-state";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { TransfersTable } from "./transfers-table";
import { BridgeOverviewSection } from "./bridge-overview-section";
import { BridgeChainFilters } from "./bridge-chain-filters";
import { useBridgeFlowUrlState } from "./use-bridge-flow-url-state";
import {
  BRIDGE_PAGE_LIMIT,
  useBridgePaginationData,
} from "./use-bridge-pagination-data";
import type {
  BridgeBridger,
  BridgeDailySnapshot,
  BridgeStatus,
  BridgeTransfer,
} from "@/lib/types";

type RecentTransfersSectionProps = {
  selectedStatus: BridgeStatus | null;
  sourceChainId: number | null;
  destChainId: number | null;
  handleStatusChange: (status: BridgeStatus | null) => void;
  handleSourceChange: (chainId: number | null) => void;
  handleDestinationChange: (chainId: number | null) => void;
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
        Wormhole NTT transfers of Mento stable tokens across Celo, Monad, and
        Polygon
      </p>
    </div>
  );
}

function RecentTransfersSection({
  selectedStatus,
  sourceChainId,
  destChainId,
  handleStatusChange,
  handleSourceChange,
  handleDestinationChange,
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
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-white">Recent transfers</h2>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <BridgeChainFilters
            sourceChainId={sourceChainId}
            destChainId={destChainId}
            onSourceChange={handleSourceChange}
            onDestinationChange={handleDestinationChange}
          />
          <BridgeStatusFilter
            options={ALL_BRIDGE_STATUSES}
            selected={selectedStatus}
            onChange={handleStatusChange}
          />
        </div>
      </div>
      {hasErrorWithoutData(transfersResult.error, transfersResult.data) ? (
        <EmptyBox message="Unable to load transfers — see error above." />
      ) : transfersResult.isLoading && transfers.length === 0 ? (
        <Skeleton rows={5} />
      ) : transfers.length === 0 ? (
        <EmptyBox
          message={
            selectedStatus !== null ||
            sourceChainId !== null ||
            destChainId !== null
              ? "No bridge transfers match the selected filters."
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
            pageSize={BRIDGE_PAGE_LIMIT}
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
  const snapshotsHasHardError = hasErrorWithoutData(
    snapshotsResult.error,
    snapshotsResult.data,
  );
  const pendingHasHardError = hasErrorWithoutData(
    pendingResult.error,
    pendingRows,
  );

  return {
    deliveredHasError: hasErrorWithoutData(
      deliveredRecentResult.error,
      deliveredRecentResult.data,
    ),
    deliveredIsLoading: isLoadingEmpty(
      deliveredRecentResult.isLoading,
      deliveredTransfers.length,
    ),
    deliveredTransfers,
    error: firstErrorMessage(
      snapshotsHasHardError ? snapshotsResult.error : undefined,
      pendingHasHardError ? pendingResult.error : undefined,
    ),
    pendingCapped: pending.capped,
    pendingCount: pending.count,
    pendingHasError: pendingHasHardError,
    rates,
    snapshots,
    snapshotsCapped: snapshots.length >= 1000,
    snapshotsHasError: snapshotsHasHardError,
    snapshotsIsLoading: isLoadingEmpty(
      snapshotsResult.isLoading,
      snapshots.length,
    ),
    topBridgers,
    topBridgersHasError: hasErrorWithoutData(
      topBridgersResult.error,
      topBridgersResult.data,
    ),
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
  // Page + status + route filters are URL-backed so users can refresh, share,
  // or navigate back without losing their view. Filter changes reset page 1
  // to keep users out of empty trailing pages. The active `page` is clamped
  // against `totalPages` below to guard against stale indices from count
  // shrinkage.
  const {
    rawPage,
    selectedStatus,
    sourceChainId,
    destChainId,
    setPage,
    handleStatusChange,
    handleSourceChange,
    handleDestinationChange,
  } = useBridgeFlowUrlState();
  const pagination = useBridgePaginationData(
    rawPage,
    selectedStatus,
    sourceChainId,
    destChainId,
    setPage,
  );
  const overview = useBridgeOverviewData();
  const [toasts, addToast, dismissToast] = useBridgeToasts();
  const error = hasErrorWithoutData(
    pagination.transfersResult.error,
    pagination.transfersResult.data,
  )
    ? pagination.transfersResult.error.message
    : (overview.error ?? null);

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
        sourceChainId={sourceChainId}
        destChainId={destChainId}
        handleStatusChange={handleStatusChange}
        handleSourceChange={handleSourceChange}
        handleDestinationChange={handleDestinationChange}
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
