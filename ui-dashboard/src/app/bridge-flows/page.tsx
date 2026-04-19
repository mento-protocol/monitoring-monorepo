"use client";

import { Suspense } from "react";
import { useGQL } from "@/lib/graphql";
import {
  BRIDGE_TRANSFERS_WINDOW,
  BRIDGE_TRANSFER_COUNT,
  BRIDGE_PENDING_COUNT,
} from "@/lib/bridge-queries";
import { deriveBridgeStatus } from "@/lib/bridge-status";
import { BridgeStatusBadge } from "@/components/bridge-status-badge";
import { BridgeProviderBadge } from "@/components/bridge-provider-badge";
import { ChainIcon } from "@/components/chain-icon";
import { Tile, Skeleton, ErrorBox, EmptyBox } from "@/components/feedback";
import { Table, Row, Th, Td } from "@/components/table";
import { AddressLink } from "@/components/address-link";
import { formatWei, relativeTime, truncateAddress } from "@/lib/format";
import { NETWORKS, networkIdForChainId } from "@/lib/networks";
import type { BridgeTransfer } from "@/lib/types";

const PAGE_LIMIT = 25;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export default function BridgeFlowsPage() {
  return (
    <Suspense>
      <BridgeFlowsContent />
    </Suspense>
  );
}

function BridgeFlowsContent() {
  const afterSeconds = Math.floor(Date.now() / 1000) - THIRTY_DAYS_SECONDS;

  const transfersResult = useGQL<{ BridgeTransfer: BridgeTransfer[] }>(
    BRIDGE_TRANSFERS_WINDOW,
    { limit: PAGE_LIMIT, offset: 0, after: afterSeconds },
  );

  const countResult = useGQL<{
    BridgeTransfer_aggregate: { aggregate: { count: number } };
  }>(BRIDGE_TRANSFER_COUNT, { after: afterSeconds });

  const pendingResult = useGQL<{
    BridgeTransfer_aggregate: { aggregate: { count: number } };
  }>(BRIDGE_PENDING_COUNT);

  const transfers = transfersResult.data?.BridgeTransfer ?? [];
  const count30d =
    countResult.data?.BridgeTransfer_aggregate?.aggregate?.count ?? null;
  const pendingCount =
    pendingResult.data?.BridgeTransfer_aggregate?.aggregate?.count ?? null;

  // KPIs scoped to the current table page (25 rows). Aggregates across the
  // full 30-day window (unique-sender count, avg deliver time) would require
  // bespoke Hasura queries not supported on the free tier — deferred, and
  // the subtitles make the scope explicit.
  const deliveredOnPage = transfers.filter(
    (t) => t.status === "DELIVERED" && t.deliveredTimestamp,
  );
  // Avg deliver time needs BOTH timestamps; dest-first transfers can appear
  // as DELIVERED while sentTimestamp is still null (source event not yet
  // indexed). Exclude them from both numerator and denominator.
  const deliveredWithSend = deliveredOnPage.filter((t) => t.sentTimestamp);

  let avgTimeToDeliverSec: number | null = null;
  if (deliveredWithSend.length > 0) {
    const total = deliveredWithSend.reduce((acc, t) => {
      const sent = Number(t.sentTimestamp);
      const delivered = Number(t.deliveredTimestamp);
      return acc + Math.max(0, delivered - sent);
    }, 0);
    avgTimeToDeliverSec = total / deliveredWithSend.length;
  }

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
          value={count30d === null ? "…" : count30d.toLocaleString()}
        />
        <Tile
          label="Pending"
          value={pendingCount === null ? "…" : pendingCount.toLocaleString()}
          subtitle={
            pendingCount !== null && pendingCount > 0
              ? "Sent, awaiting delivery"
              : undefined
          }
        />
        <Tile
          label="Unique senders"
          value={loading ? "…" : uniqueSendersOnPage.toLocaleString()}
          subtitle={
            transfers.length === 0 ? "No activity yet" : "among recent 25"
          }
        />
        <Tile
          label="Avg deliver time"
          value={
            avgTimeToDeliverSec === null
              ? "—"
              : formatDurationShort(avgTimeToDeliverSec)
          }
          subtitle={
            avgTimeToDeliverSec === null
              ? undefined
              : `over ${deliveredWithSend.length} recent transfers`
          }
        />
      </section>

      <section aria-label="Recent transfers">
        <h2 className="text-lg font-semibold text-white mb-3">
          Recent transfers
        </h2>
        {loading && transfers.length === 0 ? (
          <Skeleton rows={5} />
        ) : transfers.length === 0 ? (
          <EmptyBox message="No bridge transfers in the last 30 days." />
        ) : (
          <TransfersTable transfers={transfers} />
        )}
      </section>
    </div>
  );
}

function TransfersTable({ transfers }: { transfers: BridgeTransfer[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Provider</Th>
          <Th>Status</Th>
          <Th>Token</Th>
          <Th>Route</Th>
          <Th align="right">Amount</Th>
          <Th>Sender</Th>
          <Th align="right">Age</Th>
        </tr>
      </thead>
      <tbody>
        {transfers.map((t) => {
          const status = deriveBridgeStatus(t);
          return (
            <Row key={t.id}>
              <Td>
                <BridgeProviderBadge provider={t.provider} />
              </Td>
              <Td>
                <BridgeStatusBadge status={status} />
              </Td>
              <Td>
                <span className="font-mono text-slate-200">
                  {t.tokenSymbol}
                </span>
              </Td>
              <Td>
                <RouteCell
                  sourceChainId={t.sourceChainId}
                  destChainId={t.destChainId}
                />
              </Td>
              <Td align="right" mono>
                {t.amount ? formatWei(t.amount, t.tokenDecimals ?? 18, 2) : "—"}
              </Td>
              <Td>
                <SenderCell sender={t.sender} chainId={t.sourceChainId} />
              </Td>
              <Td align="right" small muted>
                {t.sentTimestamp
                  ? relativeTime(t.sentTimestamp)
                  : relativeTime(t.firstSeenAt)}
              </Td>
            </Row>
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

function formatDurationShort(seconds: number): string {
  // Normalize to whole seconds once, then floor-divide by unit. Avoids the
  // "1m 60s" / "60s" artifact that occurs when the higher unit is floor'd
  // but the remainder is round'd.
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
