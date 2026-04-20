"use client";

import { Suspense, useMemo, useState } from "react";
import { useBridgeGQL } from "@/lib/bridge-flows/use-bridge-gql";
import {
  BRIDGE_TRANSFERS_WINDOW,
  BRIDGE_TRANSFER_COUNT_SNAPSHOTS,
  BRIDGE_PENDING_IDS,
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
import { networkForChainId } from "@/lib/networks";
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
import { wormholescanUrl } from "@/lib/wormhole/urls";
import type { BridgeProvider, BridgeTransfer } from "@/lib/types";

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

  // Aggregates are disabled on hosted Hasura — sum pre-rolled
  // BridgeDailySnapshot.sentCount instead.
  const countResult = useBridgeGQL<{
    BridgeDailySnapshot: Array<{ sentCount: number }>;
  }>(BRIDGE_TRANSFER_COUNT_SNAPSHOTS, { afterDate: afterDayBucket });

  // Pending: paginate IDs, count client-side (capped at 1000). A count of
  // 1000 is a wire signal of pagination cap — surface as "1,000+".
  const pendingResult = useBridgeGQL<{ BridgeTransfer: Array<{ id: string }> }>(
    BRIDGE_PENDING_IDS,
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
  const countRows = countResult.data?.BridgeDailySnapshot;
  const count30d =
    countRows?.reduce((sum, s) => sum + (s.sentCount ?? 0), 0) ?? null;
  // Hasura silently caps this query at 1000 rows (days × providers × tokens
  // × routes). In the current 30d × 1 provider × 3 tokens × 2 routes window
  // that's ~180 rows — well under the cap. Mirror the pending-count "1,000+"
  // idiom so the tile reflects partial data when/if we ever breach it.
  const count30dCapped = countRows != null && countRows.length >= 1000;
  const pendingRows = pendingResult.data?.BridgeTransfer?.length ?? null;
  const pendingCount =
    pendingRows === null ? null : pendingRows >= 1000 ? 1000 : pendingRows;
  const pendingCapped = pendingRows !== null && pendingRows >= 1000;

  // KPIs scoped to the current 25-row table page. Cross-window aggregates
  // (unique senders, avg deliver time) aren't supported on hosted Hasura —
  // deferred; subtitles make scope explicit.
  const { avgSec: avgTimeToDeliverSec, sampleSize: avgSampleSize } =
    computeAvgDeliverTime(transfers);

  const uniqueSendersOnPage = new Set(
    transfers
      .map((t) => t.sender?.toLowerCase())
      .filter((s): s is string => !!s),
  ).size;

  const error =
    transfersResult.error?.message ??
    countResult.error?.message ??
    pendingResult.error?.message ??
    null;
  const loading =
    transfersResult.isLoading ||
    countResult.isLoading ||
    pendingResult.isLoading;

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
        <Tile
          label="Transfers (30d)"
          value={
            error
              ? "—"
              : count30d === null
                ? "…"
                : `${count30d.toLocaleString()}${count30dCapped ? "+" : ""}`
          }
          subtitle={count30dCapped ? "Partial — snapshot cap hit" : undefined}
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
          label="Unique senders"
          value={
            error ? "—" : loading ? "…" : uniqueSendersOnPage.toLocaleString()
          }
          subtitle={
            error
              ? undefined
              : transfers.length === 0
                ? "No activity yet"
                : "among recent 25"
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
          return (
            <tr
              key={t.id}
              className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors"
            >
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <BridgeProviderBadge provider={t.provider} />
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
                  address={t.tokenAddress}
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
                {usd === null
                  ? "—"
                  : `${usdFromLive ? "~" : ""}${formatUSD(usd)}`}
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono text-right">
                {amountTokens !== null
                  ? formatWei(t.amount!, t.tokenDecimals ?? 18, 2)
                  : "—"}
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
                  providerMessageId={t.providerMessageId}
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
  providerMessageId,
  sentTxHash,
  sourceChainId,
  deliveredTxHash,
  destChainId,
}: {
  provider: BridgeProvider;
  providerMessageId: string;
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
  if (provider === "WORMHOLE") {
    pills.push({
      href: wormholescanUrl(providerMessageId),
      label: "wh",
      title: "End-to-end trace on Wormholescan",
    });
  }
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
  address,
  chainId,
}: {
  symbol: string;
  address: string;
  chainId: number | null;
}) {
  const net = networkForChainId(chainId);
  if (
    !net ||
    !address ||
    address === "0x0000000000000000000000000000000000000000"
  ) {
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
