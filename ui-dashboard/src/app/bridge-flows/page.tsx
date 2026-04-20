"use client";

import { Suspense, useMemo, useState } from "react";
import { useBridgeGQL } from "@/lib/bridge-flows/use-bridge-gql";
import {
  BRIDGE_TRANSFERS_WINDOW,
  BRIDGE_DAILY_SNAPSHOT,
  BRIDGE_PENDING_IDS,
  BRIDGE_TOP_BRIDGERS,
} from "@/lib/bridge-queries";
import {
  deriveBridgeStatus,
  computeAvgDeliverTime,
  formatDurationShort,
} from "@/lib/bridge-status";
import { BridgeStatusBadge } from "@/components/bridge-status-badge";
import { BridgeProviderBadge } from "@/components/bridge-provider-badge";
import { ChainIcon } from "@/components/chain-icon";
import { Tile, Skeleton, ErrorBox, EmptyBox } from "@/components/feedback";
import { BreakdownTile } from "@/components/breakdown-tile";
import { BridgeVolumeChart } from "@/components/bridge-volume-chart";
import { BridgeTopBridgersChart } from "@/components/bridge-top-bridgers-chart";
import { BridgeTokenBreakdownChart } from "@/components/bridge-token-breakdown-chart";
import { Table, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { AddressLink } from "@/components/address-link";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import {
  formatWei,
  formatUSD,
  relativeTime,
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
import { snapshotUsdValue, windowTotals } from "@/lib/bridge-flows/snapshots";
import { wormholescanUrl } from "@/lib/wormhole/urls";
import type {
  BridgeBridger,
  BridgeDailySnapshot,
  BridgeProvider,
  BridgeTransfer,
} from "@/lib/types";

const PAGE_LIMIT = 25;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const SECONDS_PER_DAY = 86_400;

export default function BridgeFlowsPage() {
  return (
    <Suspense>
      <BridgeFlowsContent />
    </Suspense>
  );
}

function BridgeFlowsContent() {
  // Floor "now - 30d" to UTC day start — BridgeDailySnapshot.date is day-
  // bucketed, so a non-aligned cutoff drops the snapshot straddling the
  // boundary. Both the count tile and the transfers window use the same
  // cutoff so tile + table agree on coverage.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const afterDayBucket =
    nowSeconds -
    THIRTY_DAYS_SECONDS -
    ((nowSeconds - THIRTY_DAYS_SECONDS) % SECONDS_PER_DAY);

  const transfersResult = useBridgeGQL<{ BridgeTransfer: BridgeTransfer[] }>(
    BRIDGE_TRANSFERS_WINDOW,
    { limit: PAGE_LIMIT, offset: 0, after: afterDayBucket },
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
    { limit: 25 },
  );

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

  // 24h / 7d / 30d breakdowns for the KPI row, derived from the same
  // snapshot fetch that drives the volume chart. `windowTotals` does one
  // linear pass so the tile + chart + breakdown all share the single read.
  const volumeTotals = useMemo(
    () => windowTotals(snapshots, (s) => snapshotUsdValue(s, rates)),
    [snapshots, rates],
  );
  const transferTotals = useMemo(
    () => windowTotals(snapshots, (s) => s.sentCount ?? 0),
    [snapshots],
  );

  const pendingRows = pendingResult.data?.BridgeTransfer?.length ?? null;
  const pendingCount =
    pendingRows === null ? null : pendingRows >= 1000 ? 1000 : pendingRows;
  const pendingCapped = pendingRows !== null && pendingRows >= 1000;

  // Avg deliver time is scoped to the current 25-row table page — cross-
  // window averages aren't supported on hosted Hasura; deferred with the
  // scope explicit in the tile's subtitle.
  const { avgSec: avgTimeToDeliverSec, sampleSize: avgSampleSize } =
    computeAvgDeliverTime(transfers);

  const error =
    transfersResult.error?.message ??
    snapshotsResult.error?.message ??
    pendingResult.error?.message ??
    null;
  const loading =
    transfersResult.isLoading ||
    snapshotsResult.isLoading ||
    pendingResult.isLoading;
  const snapshotsError = !!snapshotsResult.error;
  const topBridgersError = !!topBridgersResult.error;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Bridge Flows</h1>
        <p className="text-sm text-slate-400">
          Wormhole NTT transfers of Mento stable tokens across Celo and Monad
          (last 30 days)
        </p>
      </div>

      {error && <ErrorBox message={error} />}

      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <BreakdownTile
          label="Volume (USD)"
          total={error ? null : volumeTotals.total}
          sub24h={volumeTotals.sub24h}
          sub7d={volumeTotals.sub7d}
          sub30d={volumeTotals.sub30d}
          isLoading={loading && snapshots.length === 0}
          hasError={!!error}
          format={formatUSD}
          subtitle={snapshotsCapped ? "Partial — snapshot cap hit" : undefined}
        />
        <BreakdownTile
          label="Transfers"
          total={error ? null : transferTotals.total}
          sub24h={transferTotals.sub24h}
          sub7d={transferTotals.sub7d}
          sub30d={transferTotals.sub30d}
          isLoading={loading && snapshots.length === 0}
          hasError={!!error}
          format={(n) => n.toLocaleString()}
          subtitle={snapshotsCapped ? "Partial — snapshot cap hit" : undefined}
        />
        <Tile
          label="Pending"
          value={
            error
              ? "—"
              : pendingCount === null
                ? "…"
                : pendingCapped
                  ? "1,000+"
                  : pendingCount.toLocaleString()
          }
          subtitle={
            !error && pendingCount !== null && pendingCount > 0
              ? "In-flight or attested, awaiting delivery"
              : undefined
          }
        />
        <Tile
          label="Avg deliver time"
          value={
            error || avgTimeToDeliverSec === null
              ? "—"
              : formatDurationShort(avgTimeToDeliverSec)
          }
          subtitle={
            error || avgTimeToDeliverSec === null
              ? undefined
              : `over ${avgSampleSize} recent transfers`
          }
        />
      </section>

      <section aria-label="Volume over time">
        <BridgeVolumeChart
          snapshots={snapshots}
          rates={rates}
          isLoading={snapshotsResult.isLoading && snapshots.length === 0}
          hasError={snapshotsError}
          isCapped={snapshotsCapped}
        />
      </section>

      <section
        aria-label="Bridge composition"
        className="grid grid-cols-1 lg:grid-cols-3 gap-6"
      >
        <div className="lg:col-span-2">
          <BridgeTopBridgersChart
            bridgers={topBridgers}
            isLoading={topBridgersResult.isLoading && topBridgers.length === 0}
            hasError={topBridgersError}
          />
        </div>
        <div className="lg:col-span-1">
          <BridgeTokenBreakdownChart
            snapshots={snapshots}
            rates={rates}
            isLoading={snapshotsResult.isLoading && snapshots.length === 0}
            hasError={snapshotsError}
          />
        </div>
      </section>

      <section aria-label="Recent transfers">
        <h2 className="text-lg font-semibold text-white mb-3">
          Recent transfers
        </h2>
        {error ? (
          <EmptyBox message="Unable to load transfers — see error above." />
        ) : loading && transfers.length === 0 ? (
          <Skeleton rows={5} />
        ) : transfers.length === 0 ? (
          <EmptyBox message="No bridge transfers in the last 30 days." />
        ) : (
          <TransfersTable transfers={transfers} rates={rates} />
        )}
      </section>
    </div>
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
            Amount (USD)
          </SortableTh>
          <SortableTh
            sortKey="amount"
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
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <WormholescanLink href={whUrl}>
                  <BridgeProviderBadge provider={t.provider} />
                </WormholescanLink>
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <RouteCell
                  sourceChainId={t.sourceChainId}
                  destChainId={t.destChainId}
                />
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <BridgeStatusBadge status={status} />
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3 text-sm">
                <TokenCell
                  symbol={t.tokenSymbol}
                  chainId={t.sourceChainId ?? t.destChainId}
                />
              </td>
              <td
                className="px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono text-right"
                title={
                  usdFromLive
                    ? "USD priced at render time from current oracle rate"
                    : undefined
                }
              >
                <WormholescanLink href={whUrl}>
                  {usd === null
                    ? "—"
                    : `${usdFromLive ? "~" : ""}${formatUSD(usd)}`}
                </WormholescanLink>
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono text-right">
                <WormholescanLink href={whUrl}>
                  {amountTokens !== null
                    ? formatWei(t.amount!, t.tokenDecimals ?? 18, 2)
                    : "—"}
                </WormholescanLink>
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3 text-sm">
                <SenderCell sender={t.sender} chainId={t.sourceChainId} />
              </td>
              <td
                className={`px-2 sm:px-4 py-2 sm:py-3 text-sm ${sameParties ? "opacity-50" : ""}`}
                title={sameParties ? "Same as sender" : undefined}
              >
                <SenderCell sender={t.recipient} chainId={t.destChainId} />
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <TxLinks
                  provider={t.provider}
                  sentTxHash={t.sentTxHash}
                  sourceChainId={t.sourceChainId}
                  deliveredTxHash={t.deliveredTxHash}
                  destChainId={t.destChainId}
                />
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs text-slate-400 font-mono text-right whitespace-nowrap">
                {t.sentTimestamp
                  ? relativeTime(t.sentTimestamp)
                  : relativeTime(t.firstSeenAt)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
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

/**
 * Wraps children in an anchor to a Wormholescan tx page when `href` is set,
 * or passes them through untouched when the row has no source tx yet. Keeps
 * the cell's typography — the anchor only adds a subtle hover tint so the
 * visible content isn't restyled into blue link colors.
 */
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
  if (!sender) return <span className="text-slate-500">{"\u2014"}</span>;
  if (!chainId) {
    return (
      <span className="font-mono text-xs text-slate-400">
        {truncateAddress(sender)}
      </span>
    );
  }
  return <AddressLink address={sender} chainId={chainId} />;
}
