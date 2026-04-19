"use client";

import { Suspense } from "react";
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

  // Bridge count via snapshot sum — aggregates are disabled on Envio hosted
  // Hasura, so we can't `BridgeTransfer_aggregate`. BridgeDailySnapshot is
  // pre-rolled in the indexer and fits easily under the 1000-row cap.
  // `date` is day-bucketed (ts / 86400 * 86400), so floor `afterSeconds` to
  // the corresponding day or we miss the bucket straddling the cutoff.
  const SECONDS_PER_DAY = 86400;
  const afterDayBucket = afterSeconds - (afterSeconds % SECONDS_PER_DAY);
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
