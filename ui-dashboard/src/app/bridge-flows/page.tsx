"use client";

import { Suspense, useMemo, useState } from "react";
import { useGQL } from "@/lib/graphql";
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
import { Table } from "@/components/table";
import { AddressLink } from "@/components/address-link";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import {
  formatWei,
  formatUSD,
  parseWei,
  relativeTime,
  truncateAddress,
} from "@/lib/format";
import { NETWORKS, networkIdForChainId } from "@/lib/networks";
import {
  explorerAddressUrl,
  tokenToUSD,
  type OracleRateMap,
} from "@/lib/tokens";
import type { SortDir } from "@/lib/table-sort";
import type { BridgeTransfer } from "@/lib/types";

const PAGE_LIMIT = 25;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

type SortKey =
  | "provider"
  | "route"
  | "status"
  | "token"
  | "amount"
  | "amountUsd"
  | "sender"
  | "receiver"
  | "age";

export default function BridgeFlowsPage() {
  return (
    <Suspense>
      <BridgeFlowsContent />
    </Suspense>
  );
}

function BridgeFlowsContent() {
  // Single cutoff for both queries so the tile and the table cover the
  // same window. BridgeDailySnapshot.date is UTC-day-bucketed, so we floor
  // "now - 30d" to the day start — otherwise the snapshot straddling the
  // cutoff would be dropped. `BridgeTransfer.firstSeenAt` uses the same
  // floored cutoff so the table + count agree on the window (accepting a
  // partial-day widening of up to 24h, clearly labelled in the tile).
  const SECONDS_PER_DAY = 86400;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const afterDayBucket =
    nowSeconds -
    THIRTY_DAYS_SECONDS -
    ((nowSeconds - THIRTY_DAYS_SECONDS) % SECONDS_PER_DAY);

  const transfersResult = useGQL<{ BridgeTransfer: BridgeTransfer[] }>(
    BRIDGE_TRANSFERS_WINDOW,
    { limit: PAGE_LIMIT, offset: 0, after: afterDayBucket },
  );

  // Bridge count via snapshot sum — aggregates are disabled on Envio hosted
  // Hasura, so we can't `BridgeTransfer_aggregate`. BridgeDailySnapshot is
  // pre-rolled in the indexer and fits easily under the 1000-row cap.
  const countResult = useGQL<{
    BridgeDailySnapshot: Array<{ sentCount: number }>;
  }>(BRIDGE_TRANSFER_COUNT_SNAPSHOTS, {
    afterDate: afterDayBucket,
  });

  // Pending: paginate IDs and count client-side (capped at 1000 by the query).
  // A count of 1000 is a wire signal of pagination cap — surface as "1,000+".
  const pendingResult = useGQL<{ BridgeTransfer: Array<{ id: string }> }>(
    BRIDGE_PENDING_IDS,
  );

  // Oracle rate map for USD conversion — bridged tokens (USDm/GBPm/EURm/…)
  // are priced via pool oracles already loaded for pools/revenue pages, so
  // SWR-caches across navigation. Merge rates across all networks so a
  // Monad-originated transfer can price through Celo oracles if needed.
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
  const count30d =
    countResult.data?.BridgeDailySnapshot?.reduce(
      (sum, s) => sum + (s.sentCount ?? 0),
      0,
    ) ?? null;
  const pendingRows = pendingResult.data?.BridgeTransfer?.length ?? null;
  const pendingCount =
    pendingRows === null ? null : pendingRows >= 1000 ? 1000 : pendingRows;
  const pendingCapped = pendingRows !== null && pendingRows >= 1000;

  // KPIs scoped to the current table page (25 rows). Aggregates across the
  // full 30-day window (unique-sender count, avg deliver time) would require
  // bespoke Hasura queries not supported on the free tier — deferred, and
  // the subtitles make the scope explicit.
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

      {/*
       * When any query errored, render KPIs + table as empty placeholders
       * ("—") so a user doesn't mistake the error banner for "no activity".
       * The 4 tile values shown in the error branch are not data — they are
       * the universal unavailable sentinel.
       */}
      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <Tile
          label="Transfers (30d)"
          value={
            error ? "—" : count30d === null ? "…" : count30d.toLocaleString()
          }
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
              ? "Sent, awaiting delivery"
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
          // Don't claim "no transfers" when we simply couldn't fetch them.
          // The ErrorBox above carries the actual message.
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

function transferAmountTokens(t: BridgeTransfer): number | null {
  if (!t.amount) return null;
  return parseWei(t.amount, t.tokenDecimals ?? 18);
}

function transferAmountUsd(
  t: BridgeTransfer,
  rates: OracleRateMap,
): number | null {
  // Server-side usdValueAtSend is authoritative when the indexer has computed
  // it. Falls back to live oracle rates — loses the "at send" precision but
  // better than a blank cell for transfers pre-dating the USD-at-ingest work.
  if (t.usdValueAtSend) {
    const n = Number(t.usdValueAtSend);
    if (Number.isFinite(n)) return n;
  }
  const amt = transferAmountTokens(t);
  if (amt === null) return null;
  return tokenToUSD(t.tokenSymbol, amt, rates);
}

function routeLabel(t: BridgeTransfer): string {
  // Lexical sort key: "{src}-{dst}" with unknown chains sinking to the end.
  const src = t.sourceChainId ?? 99999;
  const dst = t.destChainId ?? 99999;
  return `${src}-${dst}`;
}

function compareNullable<T>(
  a: T | null | undefined,
  b: T | null | undefined,
  cmp: (x: T, y: T) => number,
  dir: SortDir,
): number {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1; // nulls always sink
  if (bMissing) return -1;
  const r = cmp(a, b);
  return dir === "asc" ? r : -r;
}

function sortTransfers(
  transfers: BridgeTransfer[],
  sortKey: SortKey,
  sortDir: SortDir,
  rates: OracleRateMap,
): BridgeTransfer[] {
  const sign = sortDir === "asc" ? 1 : -1;
  return [...transfers].sort((a, b) => {
    switch (sortKey) {
      case "provider":
        return sign * a.provider.localeCompare(b.provider);
      case "route":
        return sign * routeLabel(a).localeCompare(routeLabel(b));
      case "status":
        return (
          sign * deriveBridgeStatus(a).localeCompare(deriveBridgeStatus(b))
        );
      case "token":
        return sign * (a.tokenSymbol ?? "").localeCompare(b.tokenSymbol ?? "");
      case "amount":
        return compareNullable(
          transferAmountTokens(a),
          transferAmountTokens(b),
          (x, y) => x - y,
          sortDir,
        );
      case "amountUsd":
        return compareNullable(
          transferAmountUsd(a, rates),
          transferAmountUsd(b, rates),
          (x, y) => x - y,
          sortDir,
        );
      case "sender":
        return (
          sign *
          (a.sender ?? "")
            .toLowerCase()
            .localeCompare((b.sender ?? "").toLowerCase())
        );
      case "receiver":
        return (
          sign *
          (a.recipient ?? "")
            .toLowerCase()
            .localeCompare((b.recipient ?? "").toLowerCase())
        );
      case "age": {
        // "Age desc" is user-facing shorthand for "newest first" — the column
        // shows how long ago, but the underlying sort is on timestamp. desc
        // (default) = biggest timestamp first = newest on top.
        const at = Number(a.sentTimestamp ?? a.firstSeenAt ?? 0);
        const bt = Number(b.sentTimestamp ?? b.firstSeenAt ?? 0);
        return sortDir === "desc" ? bt - at : at - bt;
      }
    }
  });
}

function TransfersTable({
  transfers,
  rates,
}: {
  transfers: BridgeTransfer[];
  rates: OracleRateMap;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("age");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const handleSort = (key: SortKey) => {
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
          <SortableTh
            sortKey="age"
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
          // A tilde prefix signals "priced at read time from current oracle",
          // as opposed to the indexer-pinned "at send" value. Once the indexer
          // backfills usdValueAtSend for all rows, this branch rarely fires.
          const usdFromLiveRate = usd !== null && !t.usdValueAtSend;
          // Flag cross-wallet bridges (sender ≠ receiver). Self-bridges are
          // common and unremarkable; cross-wallet ones are more interesting
          // (third-party flows, contract sinks) — worth visually popping.
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
                  usdFromLiveRate
                    ? "USD priced at render time via current oracle rate (indexer has no at-send USD for this transfer)"
                    : undefined
                }
              >
                {usd === null
                  ? "—"
                  : `${usdFromLiveRate ? "~" : ""}${formatUSD(usd)}`}
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

interface SortableThProps {
  sortKey: SortKey;
  activeSortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}

function SortableTh({
  sortKey,
  activeSortKey,
  sortDir,
  onSort,
  align = "left",
  children,
}: SortableThProps) {
  const isActive = sortKey === activeSortKey;
  const alignClass = align === "right" ? "text-right" : "text-left";
  const buttonAlign = align === "right" ? "justify-end" : "";
  return (
    <th
      scope="col"
      aria-sort={
        isActive ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
      className={`px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 ${alignClass} whitespace-nowrap`}
    >
      <button
        type="button"
        className={`flex items-center gap-1 cursor-pointer select-none hover:text-slate-200 bg-transparent border-0 p-0 font-medium text-xs sm:text-sm text-slate-400 hover:text-slate-200 ${buttonAlign} ${align === "right" ? "ml-auto" : ""}`}
        onClick={() => onSort(sortKey)}
      >
        {children}
        {isActive ? (
          <span className="text-indigo-400">
            {sortDir === "asc" ? "↑" : "↓"}
          </span>
        ) : (
          <span
            className="text-slate-600 text-[1.1em] leading-none"
            style={{ fontVariantEmoji: "text" }}
          >
            ↕
          </span>
        )}
      </button>
    </th>
  );
}

function RouteCell({
  sourceChainId,
  destChainId,
}: {
  sourceChainId: number | null;
  destChainId: number | null;
}) {
  const src = sourceChainId
    ? NETWORKS[networkIdForChainId(sourceChainId) ?? "celo-mainnet"]
    : null;
  const dst = destChainId
    ? NETWORKS[networkIdForChainId(destChainId) ?? "celo-mainnet"]
    : null;
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

function TokenCell({
  symbol,
  address,
  chainId,
}: {
  symbol: string;
  address: string;
  chainId: number | null;
}) {
  // Prefer the source chain; fall back to dest when source is missing (the
  // destination-first race before the source TransferSent is indexed).
  const net = chainId
    ? NETWORKS[networkIdForChainId(chainId) ?? "celo-mainnet"]
    : null;
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
