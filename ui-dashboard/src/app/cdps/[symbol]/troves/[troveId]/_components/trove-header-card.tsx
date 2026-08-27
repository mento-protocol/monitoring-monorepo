import type { ReactNode } from "react";
import { AddressLink } from "@/components/address-link";
import { Tooltip } from "@/components/tooltip";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { NETWORKS, networkIdForChainId } from "@/lib/networks";
import { explorerTxUrl } from "@/lib/tokens";
import type { CdpCollateral, CdpTrove } from "../../../../_lib/types";
import { formatTokenAmount } from "../../../../_lib/format";
import {
  formatBpsPercent,
  formatInterestRate,
  icrTextClass,
  lastOwnerAddress,
  troveManageUrl,
} from "../_lib/format";
import { TroveStatusBadge } from "./trove-status-badge";

/** Middle-ellipsize a long hex string for display — mirrors
 *  `trove-cells.tsx`'s `shortenHex` (kept local; see that file's header
 *  comment on why this route doesn't import from it). */
function shortenHex(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Relative-time value linking to its transaction on the block explorer when
 *  one is resolvable, falling back to plain text with the exact timestamp on
 *  the title. Used for the header's Opened/Closed rows. */
function EventTimeLink({
  timestamp,
  txHash,
  chainId,
  prefix,
}: {
  timestamp: string | null | undefined;
  txHash: string | null | undefined;
  chainId: number;
  prefix: string;
}) {
  if (!timestamp || timestamp === "0") {
    return <span className="text-slate-500">—</span>;
  }
  const label = relativeTime(timestamp);
  const exact = formatTimestamp(timestamp);
  if (!txHash) {
    return <span title={`${prefix} ${exact}.`}>{label}</span>;
  }
  const networkId = networkIdForChainId(chainId);
  const network = networkId ? NETWORKS[networkId] : null;
  if (network == null) {
    return (
      <span title={`${prefix} ${exact}. Transaction: ${txHash}.`}>{label}</span>
    );
  }
  return (
    <a
      href={explorerTxUrl(network, txHash)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${prefix} ${exact}. Opens transaction ${txHash}.`}
      className="text-slate-300 transition-colors hover:text-indigo-300"
    >
      {label}
    </a>
  );
}

function StatLabel({ children }: { children: ReactNode }) {
  return <p className="text-xs text-slate-500">{children}</p>;
}

function StatValue({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 font-mono text-sm text-slate-200">{children}</p>;
}

export function TroveHeaderCard({
  trove,
  collateral,
  displayedInterestRate,
}: {
  trove: CdpTrove;
  collateral: CdpCollateral;
  /** Fully resolved by the caller (`trove-detail-client.tsx`): the trove's
   *  own `interestRate` when it isn't currently batch-managed (or is
   *  closed, where the stored rate is a historical snapshot), the joined
   *  `InterestBatch.annualInterestRate` once resolved for an open
   *  batch-managed trove, or `null` while that join is pending, failed, or
   *  came back empty. Never `trove.interestRate` as a stand-in for an
   *  unresolved join — that could present a stale copied rate as current. */
  displayedInterestRate: string | null;
}) {
  return (
    <header className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-white">
          <span>{collateral.symbol}</span>
          <span className="text-slate-600">·</span>
          <span className="font-mono text-base" title={trove.troveId}>
            Trove {shortenHex(trove.troveId)}
          </span>
          <TroveStatusBadge status={trove.status} />
        </h1>
        <a
          href={troveManageUrl(trove.troveId, collateral.symbol)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-indigo-400 transition-colors hover:text-indigo-300"
        >
          Manage in app ↗
        </a>
      </div>

      <TroveHeaderStats
        trove={trove}
        collateral={collateral}
        displayedInterestRate={displayedInterestRate}
      />

      <p className="mt-4 text-xs text-slate-500">
        Values shown are indexed as of the last recorded event (
        {relativeTime(trove.lastUpdatedAt)}), which can be a plain ownership
        transfer rather than a debt or price change — not a live RPC or oracle
        read.
      </p>
    </header>
  );
}

/** The stat grid (owner/opened/closed-or-updated/rate/coll/debt/ICR) — split
 *  out of {@link TroveHeaderCard} to stay under the file's max-lines-per-
 *  function lint budget. */
function TroveHeaderStats({
  trove,
  collateral,
  displayedInterestRate,
}: {
  trove: CdpTrove;
  collateral: CdpCollateral;
  displayedInterestRate: string | null;
}) {
  const icrTimestamp = formatTimestamp(trove.lastUpdatedAt);
  // `lastUpdatedAt` is bumped by a pure NFT ownership transfer too
  // (indexer-envio/src/handlers/liquity/troveNFT.ts), not only by a
  // debt/collateral-changing event — so it's an upper bound on how old
  // debt/ICR actually are, never a guarantee they were captured at exactly
  // this time. Say so rather than implying more precision than the field
  // carries.
  const icrTitle =
    trove.icrBps < 0
      ? `Indexed ICR unavailable. Row last updated at ${icrTimestamp}.`
      : `Indexed ICR as of the last indexed event (${icrTimestamp}), which can be a plain ownership transfer rather than a price/debt change.\nNot a live RPC or oracle read.`;
  const endedAt = trove.closedAt ?? null;
  const endedTxHash = trove.closedTxHash ?? null;

  return (
    <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
      <div>
        <StatLabel>Owner</StatLabel>
        <StatValue>
          <AddressLink
            address={lastOwnerAddress(trove)}
            chainId={collateral.chainId}
          />
        </StatValue>
      </div>
      <div>
        <StatLabel>Opened</StatLabel>
        <StatValue>
          <EventTimeLink
            timestamp={trove.openedAt}
            txHash={trove.openedTxHash}
            chainId={collateral.chainId}
            prefix="Opened at"
          />
        </StatValue>
      </div>
      <div>
        <StatLabel>{endedAt == null ? "Last updated" : "Closed"}</StatLabel>
        <StatValue>
          <EventTimeLink
            timestamp={endedAt ?? trove.lastUpdatedAt}
            txHash={endedTxHash ?? trove.lastUpdatedTxHash}
            chainId={collateral.chainId}
            prefix={endedAt == null ? "Updated at" : "Closed at"}
          />
        </StatValue>
      </div>
      <div>
        <StatLabel>Rate</StatLabel>
        <StatValue>
          {formatInterestRate(displayedInterestRate)}
          {trove.interestBatchId != null && (
            <span className="ml-1 text-[10px] text-slate-500">Batch</span>
          )}
        </StatValue>
      </div>
      <div>
        <StatLabel>Collateral</StatLabel>
        <StatValue>{formatTokenAmount(trove.coll, "USDm")}</StatValue>
      </div>
      <div>
        <StatLabel>
          Debt
          <Tooltip
            content={`As of the last indexed event (${icrTimestamp}), which can be a plain ownership transfer rather than a debt change — this figure may be older. Interest has accrued since either way; not a live contract read.`}
            label="About the debt figure's staleness"
          />
        </StatLabel>
        <StatValue>
          {formatTokenAmount(trove.debt, collateral.symbol)}
        </StatValue>
      </div>
      <div>
        <StatLabel>ICR</StatLabel>
        <StatValue>
          <Tooltip content={icrTitle} asChild>
            {/* `button`, not `span` — `asChild` clones this element as the
                tooltip's focus trigger (see @/components/tooltip.tsx), and a
                non-interactive element needs an ARIA role or a native
                interactive tag to be a valid keyboard-focus target; `span
                tabIndex` alone trips jsx-a11y/no-noninteractive-tabindex. */}
            <button
              type="button"
              className={icrTextClass(trove.icrBps, collateral.mcrBps)}
            >
              {formatBpsPercent(trove.icrBps)}
            </button>
          </Tooltip>
          <span className="ml-1 text-[10px] text-slate-500">
            (MCR {formatBpsPercent(collateral.mcrBps)})
          </span>
        </StatValue>
      </div>
    </div>
  );
}
