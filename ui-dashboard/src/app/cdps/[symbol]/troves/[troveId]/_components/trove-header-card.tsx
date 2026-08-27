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
  // `Tooltip` (not a plain `title`) for the no-destination branches: a
  // `title` attribute alone is unreachable without a mouse, and this exact
  // timestamp is the only place that precision is available — most notably
  // while the schema-lag fallback omits `lastUpdatedTxHash` entirely.
  // Mirrors the sibling market table's `EventTimeValue` (trove-cells.tsx).
  if (!txHash) {
    return (
      <Tooltip content={`${prefix} ${exact}.`}>
        <span>{label}</span>
      </Tooltip>
    );
  }
  const networkId = networkIdForChainId(chainId);
  const network = networkId ? NETWORKS[networkId] : null;
  if (network == null) {
    return (
      <Tooltip content={`${prefix} ${exact}. Transaction: ${txHash}.`}>
        <span>{label}</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip
      content={`${prefix} ${exact}. Opens transaction ${txHash}.`}
      asChild
    >
      <a
        href={explorerTxUrl(network, txHash)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-slate-300 transition-colors hover:text-indigo-300"
      >
        {label}
      </a>
    </Tooltip>
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
  batchRateTimestamp = null,
  batchMissing = false,
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
  /** The joined `InterestBatch.updatedAt`, only when a batch join actually
   *  applies and resolved. A batch manager can change the batch rate
   *  without touching this trove, so this can be newer than
   *  `trove.lastUpdatedAt` — the footer below must not claim the batch rate
   *  as observed at the trove's own timestamp. Optional/defaults to `null`
   *  (no batch timestamp) so callers indifferent to batch state — most
   *  tests — don't need to pass it. */
  batchRateTimestamp?: string | null;
  /** True once the batch join has resolved successfully but found no
   *  matching `InterestBatch` row — distinct from still loading or failed,
   *  both of which already have their own disclosure. Optional/defaults to
   *  `false`. */
  batchMissing?: boolean;
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
        batchRateTimestamp={batchRateTimestamp}
        batchMissing={batchMissing}
      />

      <p className="mt-4 text-xs text-slate-500">
        Values shown are indexed as of the last recorded event (
        {relativeTime(trove.lastUpdatedAt)}), which can be a plain ownership
        transfer rather than a debt or price change — not a live RPC or oracle
        read.
        {batchRateTimestamp != null && (
          <>
            {" "}
            The batch-managed rate above is timestamped separately — see its
            tooltip — since a batch manager can update it without touching this
            trove.
          </>
        )}
      </p>
    </header>
  );
}

/** The Rate stat's "Batch" annotation — split out of {@link TroveHeaderStats}
 *  to keep it under the file's max-lines-per-function budget. Three states:
 *  not batch-managed (nothing), batch-managed with the join resolved
 *  (timestamped tooltip), and batch-managed with the join confirmed missing
 *  (an explicit "Batch missing", matching the market table's convention in
 *  `trove-cells.tsx`) — never a bare dash that reads the same as "still
 *  loading". */
function BatchRateLabel({
  interestBatchId,
  batchRateTimestamp,
  batchMissing,
}: {
  interestBatchId: string | null;
  batchRateTimestamp: string | null;
  batchMissing: boolean;
}) {
  if (interestBatchId == null) return null;
  if (batchMissing) {
    return (
      <span className="ml-1 text-[10px] text-amber-400">Batch missing</span>
    );
  }
  if (batchRateTimestamp == null) {
    return <span className="ml-1 text-[10px] text-slate-500">Batch</span>;
  }
  return (
    <Tooltip
      content={`Rate as of the batch's own last update (${formatTimestamp(batchRateTimestamp)}) — separate from this trove's own timestamp in the footer below.`}
      label="About the batch rate's timestamp"
    >
      <span className="ml-1 text-[10px] text-slate-500 cursor-help">Batch</span>
    </Tooltip>
  );
}

/** The ICR stat's tooltip-wrapped value — split out of
 *  {@link TroveHeaderStats} to keep it under the file's max-lines-per-
 *  function budget. */
function IcrStat({
  trove,
  collateral,
  icrTimestamp,
}: {
  trove: CdpTrove;
  collateral: CdpCollateral;
  icrTimestamp: string;
}) {
  // `lastUpdatedAt` (behind `icrTimestamp`) is bumped by a pure NFT
  // ownership transfer too (indexer-envio/src/handlers/liquity/troveNFT.ts),
  // not only by a debt/collateral-changing event — so it's an upper bound
  // on how old the ICR actually is, never a guarantee it was captured at
  // exactly this time. Say so rather than implying more precision than the
  // field carries.
  const icrTitle =
    trove.icrBps < 0
      ? `Indexed ICR unavailable. Row last updated at ${icrTimestamp}.`
      : `Indexed ICR as of the last indexed event (${icrTimestamp}), which can be a plain ownership transfer rather than a price/debt change.\nNot a live RPC or oracle read.`;
  return (
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
  );
}

/** The stat grid (owner/opened/closed-or-updated/rate/coll/debt/ICR) — split
 *  out of {@link TroveHeaderCard} to stay under the file's max-lines-per-
 *  function lint budget. */
function TroveHeaderStats({
  trove,
  collateral,
  displayedInterestRate,
  batchRateTimestamp,
  batchMissing,
}: {
  trove: CdpTrove;
  collateral: CdpCollateral;
  displayedInterestRate: string | null;
  batchRateTimestamp: string | null;
  batchMissing: boolean;
}) {
  const icrTimestamp = formatTimestamp(trove.lastUpdatedAt);
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
          <BatchRateLabel
            interestBatchId={trove.interestBatchId}
            batchRateTimestamp={batchRateTimestamp}
            batchMissing={batchMissing}
          />
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
        <IcrStat
          trove={trove}
          collateral={collateral}
          icrTimestamp={icrTimestamp}
        />
      </div>
    </div>
  );
}
