/**
 * TransfersTable sub-component extracted verbatim from `bridge-flows/page.tsx`
 * (refactor/bridge-flows-transfers-table). Owns the sort state, header-click
 * handling, sortable-header rendering, and table-body rendering. Delegates
 * each row's individual cells to the co-located `transfer-row-cells` module.
 */

"use client";

import { useState, useMemo } from "react";
import { BridgeStatusBadge } from "@/components/bridge-status-badge";
import { BridgeProviderBadge } from "@/components/bridge-provider-badge";
import { Table, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { formatWei, formatUSD } from "@/lib/format";
import { sortTransfers, type BridgeSortKey } from "@/lib/bridge-flows/sort";
import {
  transferAmountUsd,
  usdPricedFromLiveRate,
} from "@/lib/bridge-flows/pricing";
import { canManuallyRedeemTransfer } from "@/lib/bridge-flows/redeem";
import { deriveBridgeStatus } from "@/lib/bridge-status";
import { wormholescanUrl } from "@/lib/wormhole/urls";
import { type OracleRateMap } from "@/lib/tokens";
import type { AddToast } from "@/components/bridge-redeem-cta";
import type { BridgeTransfer } from "@/lib/types";
import {
  DurationCell,
  RouteCell,
  SenderCell,
  TimeCell,
  TokenCell,
  TxLinks,
  WormholescanLink,
} from "./transfer-row-cells";

export function TransfersTable({
  transfers,
  rates,
  addToast,
}: {
  transfers: BridgeTransfer[];
  rates: OracleRateMap;
  addToast: AddToast;
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
          const usd = transferAmountUsd(t, rates);
          const usdFromLive = usd !== null && usdPricedFromLiveRate(t);
          const sameParties =
            !!t.sender &&
            !!t.recipient &&
            t.sender.toLowerCase() === t.recipient.toLowerCase();
          const whUrl =
            t.provider === "WORMHOLE" && t.sentTxHash
              ? wormholescanUrl(t.sentTxHash)
              : null;
          const redeemProps =
            status === "STUCK" && canManuallyRedeemTransfer(t)
              ? {
                  sentTxHash: t.sentTxHash!,
                  destChainId: t.destChainId!,
                  tokenSymbol: t.tokenSymbol,
                }
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
                  {t.amount && (
                    <div className="text-xs text-slate-500">
                      {formatWei(t.amount, t.tokenDecimals ?? 18, 2)}
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
                  redeemProps={redeemProps}
                  addToast={addToast}
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
