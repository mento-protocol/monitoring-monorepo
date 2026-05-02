"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { TransfersTable } from "./_components/transfers-table";
import { BridgeOverviewSection } from "./_components/bridge-overview-section";
import type {
  BridgeBridger,
  BridgeDailySnapshot,
  BridgeStatus,
  BridgeTransfer,
} from "@/lib/types";

const PAGE_LIMIT = 25;

export default function BridgeFlowsPage() {
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
  const searchParams = useSearchParams();
  const router = useRouter();

  const rawPage = Math.max(
    1,
    parseInt(searchParams.get("page") ?? "1", 10) || 1,
  );

  // null = ALL (default); a specific status = radio-selected filter.
  const selectedStatus = useMemo<BridgeStatus | null>(() => {
    const param = searchParams.get("status");
    if (param === null) return null;
    const validSet = new Set<string>(ALL_BRIDGE_STATUSES);
    return validSet.has(param) ? (param as BridgeStatus) : null;
  }, [searchParams]);

  // Expand the single selection into the array the query expects.
  const statusIn =
    selectedStatus !== null ? [selectedStatus] : ALL_BRIDGE_STATUSES.slice();

  const setPage = useCallback(
    (p: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (p === 1) params.delete("page");
      else params.set("page", String(p));
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const handleStatusChange = useCallback(
    (next: BridgeStatus | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === null) params.delete("status");
      else params.set("status", next);
      params.delete("page"); // reset to page 1 on filter change
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Total row count for the pagination denominator. Shape matches
  // POOL_SWAPS_COUNT: fetch up to ENVIO_MAX_ROWS IDs and count client-side,
  // since hosted Hasura has no _aggregate support. Preserved-last-known
  // pattern avoids the pager collapsing on a transient count error.
  const countResult = useBridgeGQL<{ BridgeTransfer: Array<{ id: string }> }>(
    BRIDGE_TRANSFERS_COUNT,
    {
      statusIn,
      limit: ENVIO_MAX_ROWS,
    },
  );
  const lastKnownTotalRef = useRef(0);
  // Reset the preserved-last-known denominator whenever the filter changes —
  // otherwise a transient count error on a new filter surfaces the previous
  // filter's total (e.g. "91 total" for a narrower filter that really has 3
  // matches).
  const statusKey = selectedStatus ?? "all";
  useEffect(() => {
    lastKnownTotalRef.current = 0;
  }, [statusKey]);
  const rawTotal = countResult.data?.BridgeTransfer.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  // On count error, fall back to the preserved value but gate `totalCapped`
  // on that same preserved value — otherwise a transient error with a stale
  // ref of 0 could claim rawTotal < ENVIO_MAX_ROWS while the banner reads
  // off whatever last-known count we held.
  const total = countResult.error ? lastKnownTotalRef.current : rawTotal;
  const totalCapped = !countResult.error && rawTotal >= ENVIO_MAX_ROWS;

  // Clamp the active page against totalPages — guards against stale URL
  // indices when the count shrinks (window roll, narrower filter on refresh).
  // `handleStatusChange` resets via URL param delete for the common case.
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

  // All-time daily snapshots feed both the KPI row (24h/7d/30d sums) and the
  // charts. One fetch → many derived views. `afterDate: 0` requests all
  // history; at the cap (1000 rows ≈ ~80 days at current cardinality) the
  // query returns the most-recent days because of the `date desc` ordering.
  const snapshotsResult = useBridgeGQL<{
    BridgeDailySnapshot: BridgeDailySnapshot[];
  }>(BRIDGE_DAILY_SNAPSHOT, { afterDate: 0 });

  // Pending: paginate IDs, count client-side (capped at 1000). A count of
  // 1000 is a wire signal of pagination cap — surface as "1,000+".
  const pendingResult = useBridgeGQL<{ BridgeTransfer: Array<{ id: string }> }>(
    BRIDGE_PENDING_IDS,
  );

  // Top bridgers for the leaderboard chart. 25 is the expanded-view cap.
  const topBridgersResult = useBridgeGQL<{ BridgeBridger: BridgeBridger[] }>(
    BRIDGE_TOP_BRIDGERS,
    { limit: TOP_BRIDGERS_EXPANDED },
  );

  // Last ROUTE_STATS_LIMIT delivered transfers for the per-route avg delivery
  // time tile. Fetched independently so the tile's sample is not capped by the
  // table's PAGE_LIMIT or the current status filter.
  const deliveredRecentResult = useBridgeGQL<{
    BridgeTransfer: Array<{
      status: BridgeStatus;
      sentTimestamp: string | null;
      deliveredTimestamp: string | null;
      sourceChainId: number | null;
      destChainId: number | null;
    }>;
  }>(BRIDGE_DELIVERED_RECENT, { limit: ROUTE_STATS_LIMIT });

  // Oracle rate map for USD conversion. Uses the slim `useOracleRates` hook
  // instead of `useAllNetworksData`: we only need ~5 fields per pool to build
  // the rate map, not the full 44-field per-pool payload plus paginated
  // snapshots / LPs / fees that the dashboard hook fetches. Saves ~6 queries
  // per chain per bridge-page mount.
  const { merged: rates } = useOracleRates();

  const transfers = transfersResult.data?.BridgeTransfer ?? [];
  const snapshots = snapshotsResult.data?.BridgeDailySnapshot ?? [];
  const snapshotsCapped = snapshots.length >= 1000;
  const topBridgers = topBridgersResult.data?.BridgeBridger ?? [];

  const transferTotals = useMemo(
    () => windowTotals(snapshots, (s) => s.sentCount ?? 0),
    [snapshots],
  );

  const pendingRows = pendingResult.data?.BridgeTransfer?.length ?? null;
  const pendingCount =
    pendingRows === null ? null : pendingRows >= 1000 ? 1000 : pendingRows;
  const pendingCapped = pendingRows !== null && pendingRows >= 1000;

  // Aggregate only for the top-of-page ErrorBox banner — each KPI tile +
  // chart + table below gates on its own backing query's error so a partial
  // failure doesn't mask valid data from the other queries.
  const error =
    transfersResult.error?.message ??
    snapshotsResult.error?.message ??
    pendingResult.error?.message ??
    null;
  const snapshotsError = !!snapshotsResult.error;
  const topBridgersError = !!topBridgersResult.error;
  const pendingError = !!pendingResult.error;
  const deliveredError = !!deliveredRecentResult.error;

  const toastIdRef = useRef(0);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const addToast = useCallback<AddToast>((message, type, href) => {
    const id = ++toastIdRef.current;
    setToasts((t) => [...t, { id, message, type, href }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6_000);
  }, []);

  return (
    <div className="space-y-8">
      <ToastPortal
        toasts={toasts}
        onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
      />
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Bridge Flows</h1>
        <p className="text-sm text-slate-400">
          Wormhole NTT transfers of Mento stable tokens across Celo and Monad
        </p>
      </div>

      {error && <ErrorBox message={error} />}

      <BridgeOverviewSection
        snapshots={snapshots}
        rates={rates}
        snapshotsIsLoading={snapshotsResult.isLoading && snapshots.length === 0}
        snapshotsHasError={snapshotsError}
        snapshotsCapped={snapshotsCapped}
        topBridgers={topBridgers}
        topBridgersIsLoading={
          topBridgersResult.isLoading && topBridgers.length === 0
        }
        topBridgersHasError={topBridgersError}
        transferTotals={transferTotals}
        pendingHasError={pendingError}
        pendingCount={pendingCount}
        pendingCapped={pendingCapped}
        deliveredTransfers={deliveredRecentResult.data?.BridgeTransfer ?? []}
        deliveredIsLoading={
          deliveredRecentResult.isLoading && !deliveredRecentResult.data
        }
        deliveredHasError={deliveredError}
      />

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
                Showing first {ENVIO_MAX_ROWS.toLocaleString()} transfers —
                older entries may exist beyond this page range.
              </p>
            )}
            {countResult.error && (
              <p className="mt-1 text-xs text-slate-500">
                Total count degraded — showing last known denominator.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
