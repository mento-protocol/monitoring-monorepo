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
import { TOP_BRIDGERS_EXPANDED } from "@/lib/bridge-flows/layout";
import {
  ALL_BRIDGE_STATUSES,
  deriveBridgeStatus,
  formatDurationShort,
  transferDeliveryDurationSec,
} from "@/lib/bridge-status";
import { BridgeStatusBadge } from "@/components/bridge-status-badge";
import { BridgeStatusFilter } from "@/components/bridge-status-filter";
import { BridgeProviderBadge } from "@/components/bridge-provider-badge";
import { ChainIcon } from "@/components/chain-icon";
import { Tile, Skeleton, ErrorBox, EmptyBox } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { BreakdownTile } from "@/components/breakdown-tile";
import { BridgeVolumeChart } from "@/components/bridge-volume-chart";
import { BridgeTopBridgersChart } from "@/components/bridge-top-bridgers-chart";
import { BridgeTokenBreakdownChart } from "@/components/bridge-token-breakdown-chart";
import { Table, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { AddressLink } from "@/components/address-link";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import {
  formatWei,
  formatUSD,
  relativeTime,
  formatTimestamp,
  truncateAddress,
} from "@/lib/format";
import { networkForChainId, tokenAddressForSymbol } from "@/lib/networks";
import {
  explorerAddressUrl,
  explorerTxUrl,
  type OracleRateMap,
} from "@/lib/tokens";
import { sortTransfers, type BridgeSortKey } from "@/lib/bridge-flows/sort";
import {
  transferAmountTokens,
  transferAmountUsd,
  usdPricedFromLiveRate,
} from "@/lib/bridge-flows/pricing";
import { windowTotals } from "@/lib/bridge-flows/snapshots";
import { computeRouteAvgDeliverTimes } from "@/lib/bridge-flows/route-stats";
import { wormholescanUrl } from "@/lib/wormhole/urls";
import type {
  BridgeBridger,
  BridgeDailySnapshot,
  BridgeProvider,
  BridgeStatus,
  BridgeTransfer,
} from "@/lib/types";

const PAGE_LIMIT = 25;
const ROUTE_STATS_LIMIT = 100;

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

  const selectedStatuses = useMemo<BridgeStatus[]>(() => {
    const param = searchParams.get("statuses");
    // null  → param absent → show all (default)
    // ""    → user deselected everything → empty selection (skip polling)
    if (param === null) return ALL_BRIDGE_STATUSES.slice();
    const validSet = new Set<string>(ALL_BRIDGE_STATUSES);
    const parts = [
      ...new Set(
        param.split(",").filter((s): s is BridgeStatus => validSet.has(s)),
      ),
    ];
    return parts;
  }, [searchParams]);

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
    (next: BridgeStatus[]) => {
      const params = new URLSearchParams(searchParams.toString());
      const nextSet = new Set(next);
      const isAll = ALL_BRIDGE_STATUSES.every((s) => nextSet.has(s));
      if (isAll) params.delete("statuses");
      else params.set("statuses", next.join(","));
      params.delete("page"); // reset to page 1 on filter change
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // When the user toggles statuses to an empty set, SWR key is nulled and
  // no fetch happens — the EmptyBox below handles the UI copy. Otherwise
  // callers would poll a `status: _in: []` query on every refresh interval
  // just to get back an empty array.
  const hasSelectedStatuses = selectedStatuses.length > 0;

  // Total row count for the pagination denominator. Shape matches
  // POOL_SWAPS_COUNT: fetch up to ENVIO_MAX_ROWS IDs and count client-side,
  // since hosted Hasura has no _aggregate support. Preserved-last-known
  // pattern avoids the pager collapsing on a transient count error.
  const countResult = useBridgeGQL<{ BridgeTransfer: Array<{ id: string }> }>(
    hasSelectedStatuses ? BRIDGE_TRANSFERS_COUNT : null,
    {
      statusIn: selectedStatuses,
      limit: ENVIO_MAX_ROWS,
    },
  );
  const lastKnownTotalRef = useRef(0);
  // Reset the preserved-last-known denominator whenever the filter changes —
  // otherwise a transient count error on a new filter surfaces the previous
  // filter's total (e.g. "91 total" for a narrower filter that really has 3
  // matches). Stable-serialize the array so React's dependency comparison
  // doesn't miss in-place mutations.
  const statusKey = selectedStatuses.join("|");
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
    hasSelectedStatuses ? BRIDGE_TRANSFERS_WINDOW : null,
    {
      limit: PAGE_LIMIT,
      offset: (page - 1) * PAGE_LIMIT,
      statusIn: selectedStatuses,
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

  // Oracle rate map for USD conversion. `useAllNetworksData` is cache-shared
  // with pools/revenue via SWR, so cross-page navigation reuses the fetch.
  const { networkData } = useAllNetworksData();
  const rates = useMemo<OracleRateMap>(() => {
    const merged = new Map<string, number>();
    for (const net of networkData) {
      for (const [k, v] of net.rates.entries()) {
        if (!merged.has(k)) merged.set(k, v);
      }
    }
    return merged;
  }, [networkData]);

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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Bridge Flows</h1>
        <p className="text-sm text-slate-400">
          Wormhole NTT transfers of Mento stable tokens across Celo and Monad
        </p>
      </div>

      {error && <ErrorBox message={error} />}

      <section
        aria-label="Charts"
        className="grid grid-cols-1 lg:grid-cols-3 gap-6"
      >
        <BridgeVolumeChart
          snapshots={snapshots}
          rates={rates}
          isLoading={snapshotsResult.isLoading && snapshots.length === 0}
          hasError={snapshotsError}
          isCapped={snapshotsCapped}
        />
        <BridgeTokenBreakdownChart
          snapshots={snapshots}
          rates={rates}
          isLoading={snapshotsResult.isLoading && snapshots.length === 0}
          hasError={snapshotsError}
          isCapped={snapshotsCapped}
        />
        <BridgeTopBridgersChart
          bridgers={topBridgers}
          isLoading={topBridgersResult.isLoading && topBridgers.length === 0}
          hasError={topBridgersError}
        />
      </section>

      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 sm:grid-cols-3 gap-4"
      >
        <BreakdownTile
          label="Total Bridge Transfers"
          total={snapshotsResult.error ? null : transferTotals.total}
          sub24h={transferTotals.sub24h}
          sub7d={transferTotals.sub7d}
          sub30d={transferTotals.sub30d}
          isLoading={snapshotsResult.isLoading && snapshots.length === 0}
          hasError={!!snapshotsResult.error}
          format={(n) => n.toLocaleString()}
          subtitle={snapshotsCapped ? "Partial — snapshot cap hit" : undefined}
        />
        <Tile
          label="Pending"
          value={
            pendingResult.error
              ? "—"
              : pendingCount === null
                ? "…"
                : pendingCapped
                  ? "1,000+"
                  : pendingCount.toLocaleString()
          }
          subtitle={
            !pendingResult.error && pendingCount !== null && pendingCount > 0
              ? "In-flight or attested, awaiting delivery"
              : undefined
          }
        />
        <RouteDeliveryTile
          transfers={deliveredRecentResult.data?.BridgeTransfer ?? []}
          isLoading={
            deliveredRecentResult.isLoading && !deliveredRecentResult.data
          }
          hasError={!!deliveredRecentResult.error}
        />
      </section>

      <section aria-label="Recent transfers">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-lg font-semibold text-white">Recent transfers</h2>
          <BridgeStatusFilter
            options={ALL_BRIDGE_STATUSES}
            selected={selectedStatuses}
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
              selectedStatuses.length === 0
                ? "No statuses selected — enable at least one filter to see transfers."
                : selectedStatuses.length < ALL_BRIDGE_STATUSES.length
                  ? "No bridge transfers match the selected statuses."
                  : "No bridge transfers yet."
            }
          />
        ) : (
          <>
            <TransfersTable transfers={transfers} rates={rates} />
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

function RouteDeliveryTile({
  transfers,
  isLoading,
  hasError,
}: {
  transfers: ReadonlyArray<
    Pick<
      BridgeTransfer,
      | "status"
      | "sentTimestamp"
      | "deliveredTimestamp"
      | "sourceChainId"
      | "destChainId"
    >
  >;
  isLoading: boolean;
  hasError: boolean;
}) {
  const routes = useMemo(
    () => computeRouteAvgDeliverTimes(transfers),
    [transfers],
  );
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 min-h-[88px]">
      <p className="text-sm text-slate-400 mb-3">Avg Delivery Time by Route</p>
      {hasError ? (
        <p className="text-2xl font-semibold text-white font-mono">—</p>
      ) : isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-4 animate-pulse rounded bg-slate-800/50"
            />
          ))}
        </div>
      ) : routes.length === 0 ? (
        <p className="text-sm text-slate-500">No delivered transfers in view</p>
      ) : (
        <div className="space-y-2">
          {routes.map((r) => (
            <div
              key={`${r.srcChainId}-${r.dstChainId}`}
              className="flex items-center gap-3"
            >
              <RouteCell
                sourceChainId={r.srcChainId}
                destChainId={r.dstChainId}
              />
              <span className="font-mono text-sm font-semibold text-white">
                {formatDurationShort(r.avgSec)}
              </span>
              <span className="text-xs text-slate-500">n={r.count}</span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        last {ROUTE_STATS_LIMIT} delivered
      </p>
    </div>
  );
}

function TimeCell({ ts, whUrl }: { ts: string | null; whUrl: string | null }) {
  const relative = ts && ts !== "0" ? relativeTime(ts) : "—";
  const precise = ts && ts !== "0" ? formatTimestamp(ts) : undefined;
  if (whUrl) {
    return (
      <a
        href={whUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={precise}
        className="text-slate-400 hover:text-indigo-300 transition-colors"
      >
        {relative}
      </a>
    );
  }
  return (
    <span className="text-slate-400" title={precise}>
      {relative}
    </span>
  );
}

function TransfersTable({
  transfers,
  rates,
}: {
  transfers: BridgeTransfer[];
  rates: OracleRateMap;
}) {
  const [sortKey, setSortKey] = useState<BridgeSortKey>("time");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (key: BridgeSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sorted = useMemo(
    () => sortTransfers(transfers, sortKey, sortDir, rates),
    [transfers, sortKey, sortDir, rates],
  );

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <SortableTh
            sortKey="provider"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          >
            Provider
          </SortableTh>
          <SortableTh
            sortKey="route"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          >
            Route
          </SortableTh>
          <SortableTh
            sortKey="status"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          >
            Status
          </SortableTh>
          <SortableTh
            sortKey="token"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          >
            Token
          </SortableTh>
          <SortableTh
            sortKey="amountUsd"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Amount
          </SortableTh>
          <SortableTh
            sortKey="sender"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          >
            Sender
          </SortableTh>
          <SortableTh
            sortKey="receiver"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          >
            Receiver
          </SortableTh>
          <Th>Txs</Th>
          <SortableTh
            sortKey="time"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Time
          </SortableTh>
          <SortableTh
            sortKey="duration"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Duration
          </SortableTh>
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => {
          const status = deriveBridgeStatus(t);
          const amountTokens = transferAmountTokens(t);
          const usd = transferAmountUsd(t, rates);
          const usdFromLive = usd !== null && usdPricedFromLiveRate(t);
          const sameParties =
            !!t.sender &&
            !!t.recipient &&
            t.sender.toLowerCase() === t.recipient.toLowerCase();
          // Wormholescan URL is the row's "canonical" trace — if we have it,
          // the transfer-level cells (provider, amount, amountUsd) all link
          // to it so operators can jump into the trace from any of those
          // columns instead of hunting for the `wh` pill at the end.
          const whUrl =
            t.provider === "WORMHOLE" && t.sentTxHash
              ? wormholescanUrl(t.sentTxHash)
              : null;
          return (
            <tr
              key={t.id}
              className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors"
            >
              <td className="px-2 sm:px-3 py-1.5 sm:py-2">
                <WormholescanLink href={whUrl}>
                  <BridgeProviderBadge provider={t.provider} />
                </WormholescanLink>
              </td>
              <td className="px-2 sm:px-3 py-1.5 sm:py-2">
                <RouteCell
                  sourceChainId={t.sourceChainId}
                  destChainId={t.destChainId}
                />
              </td>
              <td className="px-2 sm:px-3 py-1.5 sm:py-2">
                <BridgeStatusBadge status={status} />
              </td>
              <td className="px-2 sm:px-3 py-1.5 sm:py-2 text-sm">
                <TokenCell
                  symbol={t.tokenSymbol}
                  chainId={t.sourceChainId ?? t.destChainId}
                />
              </td>
              <td className="px-2 sm:px-3 py-1.5 sm:py-2 font-mono text-right">
                <WormholescanLink href={whUrl}>
                  <div
                    className="text-sm text-slate-200"
                    title={
                      usdFromLive
                        ? "USD priced at render time from current oracle rate"
                        : undefined
                    }
                  >
                    {usd === null
                      ? "—"
                      : `${usdFromLive ? "~" : ""}${formatUSD(usd)}`}
                  </div>
                  {amountTokens !== null && (
                    <div className="text-xs text-slate-500">
                      {formatWei(t.amount!, t.tokenDecimals ?? 18, 2)}
                    </div>
                  )}
                </WormholescanLink>
              </td>
              <td className="px-2 sm:px-3 py-1.5 sm:py-2 text-sm">
                <SenderCell sender={t.sender} chainId={t.sourceChainId} />
              </td>
              <td
                className={`px-2 sm:px-3 py-1.5 sm:py-2 text-sm ${sameParties ? "opacity-50" : ""}`}
                title={sameParties ? "Same as sender" : undefined}
              >
                <SenderCell sender={t.recipient} chainId={t.destChainId} />
              </td>
              <td className="px-2 sm:px-3 py-1.5 sm:py-2">
                <TxLinks
                  provider={t.provider}
                  sentTxHash={t.sentTxHash}
                  sourceChainId={t.sourceChainId}
                  deliveredTxHash={t.deliveredTxHash}
                  destChainId={t.destChainId}
                />
              </td>
              <td className="px-2 sm:px-3 py-1.5 sm:py-2 text-xs font-mono text-right whitespace-nowrap">
                <TimeCell ts={t.sentTimestamp ?? t.firstSeenAt} whUrl={whUrl} />
              </td>
              <DurationCell transfer={t} />
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function DurationCell({ transfer }: { transfer: BridgeTransfer }) {
  const durationSec = transferDeliveryDurationSec(transfer);
  if (durationSec === null) {
    // Mirror the STUCK overlay: any non-terminal-delivered status is
    // "pending" from a duration perspective — including the client-side
    // STUCK overlay, which should still show "pending" rather than em-dash
    // (it's unfinished, not unknown). CANCELLED/FAILED are unreachable on
    // the bridge page today (no indexer handler writes them) but the
    // em-dash branch is kept for schema-level safety.
    const derived = deriveBridgeStatus(transfer);
    const pending =
      derived !== "DELIVERED" &&
      derived !== "CANCELLED" &&
      derived !== "FAILED";
    return (
      <td
        className="px-2 sm:px-3 py-1.5 sm:py-2 text-xs text-slate-500 font-mono text-right whitespace-nowrap"
        title={
          pending
            ? "Not yet delivered"
            : "Delivery timestamp unavailable for this transfer"
        }
      >
        {pending ? "pending" : "\u2014"}
      </td>
    );
  }
  return (
    <td
      className="px-2 sm:px-3 py-1.5 sm:py-2 text-xs text-slate-400 font-mono text-right whitespace-nowrap"
      title="Source-send to destination-delivery elapsed time"
    >
      {formatDurationShort(durationSec)}
    </td>
  );
}

function RouteCell({
  sourceChainId,
  destChainId,
}: {
  sourceChainId: number | null;
  destChainId: number | null;
}) {
  const src = networkForChainId(sourceChainId);
  const dst = networkForChainId(destChainId);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
      {src ? <ChainIcon network={src} size={14} /> : <Dash />}
      <span className="text-slate-500">{"\u2192"}</span>
      {dst ? <ChainIcon network={dst} size={14} /> : <Dash />}
    </span>
  );
}

function Dash() {
  return <span className="text-slate-600">{"\u2014"}</span>;
}

/** Wraps children in a Wormholescan tx anchor when href is set. Keeps the
 * cell's typography — no blue link recolor on the content. */
function WormholescanLink({
  href,
  children,
}: {
  href: string | null;
  children: React.ReactNode;
}) {
  if (!href) return <>{children}</>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open on Wormholescan"
      className="hover:text-indigo-300 transition-colors"
    >
      {children}
    </a>
  );
}

function TxPill({
  href,
  label,
  title,
}: {
  href: string;
  label: string;
  title: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="inline-flex items-center gap-0.5 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
    >
      {label}
      <span aria-hidden="true" className="text-slate-600">
        {"\u2197"}
      </span>
    </a>
  );
}

function TxLinks({
  provider,
  sentTxHash,
  sourceChainId,
  deliveredTxHash,
  destChainId,
}: {
  provider: BridgeProvider;
  sentTxHash: string | null;
  sourceChainId: number | null;
  deliveredTxHash: string | null;
  destChainId: number | null;
}) {
  const src = networkForChainId(sourceChainId);
  const dst = networkForChainId(destChainId);
  const pills: Array<{ href: string; label: string; title: string }> = [];
  if (sentTxHash && src) {
    pills.push({
      href: explorerTxUrl(src, sentTxHash),
      label: "src",
      title: `Source tx on ${src.label}`,
    });
  }
  if (deliveredTxHash && dst) {
    pills.push({
      href: explorerTxUrl(dst, deliveredTxHash),
      label: "dst",
      title: `Destination tx on ${dst.label}`,
    });
  }
  // Wormholescan only resolves by source tx hash or VAA ID; digest alone
  // 404s. Skip the pill when we don't have the source tx yet.
  if (provider === "WORMHOLE" && sentTxHash) {
    pills.push({
      href: wormholescanUrl(sentTxHash),
      label: "wh",
      title: "End-to-end trace on Wormholescan",
    });
  }
  if (pills.length === 0) return <Dash />;
  return (
    <span className="inline-flex items-center gap-1">
      {pills.map((p) => (
        <TxPill key={p.label} {...p} />
      ))}
    </span>
  );
}

function TokenCell({
  symbol,
  chainId,
}: {
  symbol: string;
  chainId: number | null;
}) {
  // Resolve the per-chain token address from @mento-protocol/contracts via
  // the network's tokenSymbols map — NOT from the indexer-stored
  // BridgeTransfer.tokenAddress. The NTT hub/spoke model deploys a distinct
  // token address per chain, and legacy indexer data (pre-b390cc9) can carry
  // the destination-chain's address tagged with the source chain id, which
  // would produce broken cross-chain explorer links. Symbol + chainId is
  // authoritative and stable across indexer state.
  const net = networkForChainId(chainId);
  const address = net ? tokenAddressForSymbol(net, symbol) : null;
  if (!net || !address) {
    return <span className="font-mono text-slate-200">{symbol}</span>;
  }
  return (
    <a
      href={explorerAddressUrl(net, address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className="font-mono text-slate-200 hover:text-indigo-300 transition-colors"
    >
      {symbol}
      <span className="ml-1 text-slate-600" aria-hidden="true">
        {"\u2197"}
      </span>
    </a>
  );
}

function SenderCell({
  sender,
  chainId,
}: {
  sender: string | null;
  chainId: number | null;
}) {
  if (!sender) return <Dash />;
  if (!chainId) {
    return (
      <span className="font-mono text-xs text-slate-400">
        {truncateAddress(sender)}
      </span>
    );
  }
  return <AddressLink address={sender} chainId={chainId} />;
}
