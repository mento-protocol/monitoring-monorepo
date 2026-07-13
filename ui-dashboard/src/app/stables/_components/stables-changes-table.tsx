"use client";

import { useEffect, useState } from "react";
import { AddressLink } from "@/components/address-link";
import { TableSkeleton } from "@/components/skeletons";
import {
  formatTimestamp,
  formatWei,
  relativeTime,
  truncateAddress,
} from "@/lib/format";
import { NETWORKS, networkIdForChainId } from "@/lib/networks";
import { displayLabel, isMintKind, kindLabel } from "@/lib/stables";
import { explorerTxUrl } from "@/lib/tokens";
import {
  DEFAULT_SUPPLY_CHANGE_MIN_USD,
  formatSupplyChangeUsdThreshold,
} from "../_lib/aggregate";
import type { StableSupplyChangeEvent } from "../_lib/types";

const SUPPLY_CHANGES_PAGE_SIZE = 50;

// Loading-skeleton row count. Approximates a typical settled row count
// (production audit measured ~932px for 20 real rows) rather than the
// pagination page size (50) — a generous-but-imperfect floor beats the
// original single text line, per the sparkline grid's identical tradeoff.
const SUPPLY_CHANGES_SKELETON_ROWS = 20;
// Mirrors TableSkeleton's measured `variant="rows"` geometry (header ≈36px,
// rows ≈44px — those constants live in skeletons.tsx but aren't exported)
// plus the real pagination footer's measured box (border-t + pt-4 + one
// text line ≈ 1 + 16 + 16 = 33px) and its mt-4 top margin. Reserving this
// height keeps the card from visibly shrinking/growing across the
// loading → empty/error/loaded-with-data swap, and (combined with the
// `isLoading || hasPendingPage` gate in stables-page-client.tsx) from
// growing in waves as successive raw pages resolve.
const SUPPLY_CHANGES_HEADER_HEIGHT_PX = 36;
const SUPPLY_CHANGES_ROW_HEIGHT_PX = 44;
const SUPPLY_CHANGES_FOOTER_MARGIN_TOP_PX = 16;
const SUPPLY_CHANGES_FOOTER_HEIGHT_PX = 33;
const SUPPLY_CHANGES_RESERVED_HEIGHT_PX =
  SUPPLY_CHANGES_HEADER_HEIGHT_PX +
  SUPPLY_CHANGES_SKELETON_ROWS * SUPPLY_CHANGES_ROW_HEIGHT_PX +
  SUPPLY_CHANGES_FOOTER_MARGIN_TOP_PX +
  SUPPLY_CHANGES_FOOTER_HEIGHT_PX;

type Props = {
  events: ReadonlyArray<StableSupplyChangeEvent>;
  minimumUsdValue: number;
  onMinimumUsdValueChange: (next: number) => void;
  onMinimumUsdValueReset: () => void;
  isLoading: boolean;
  hasError: boolean;
  capped: boolean;
  unpricedEventsCount: number;
};

/**
 * supply-changes table — every Transfer-with-zero on the subscribed
 * stables, labeled by kind (RESERVE_MINT / BRIDGE_BURN / etc) and linked
 * to the on-chain tx + caller address.
 *
 * V3 Liquity CDP mint/burn events (TroveOperationEvent / RedemptionEvent /
 * LiquidationEvent) are deferred to PR2.5 — they carry source-specific
 * fields that need a richer per-row layout.
 */
export function StablesChangesTable({
  events,
  minimumUsdValue,
  onMinimumUsdValueChange,
  onMinimumUsdValueReset,
  isLoading,
  hasError,
  capped,
  unpricedEventsCount,
}: Props): React.JSX.Element {
  const thresholdLabel = formatSupplyChangeUsdThreshold(minimumUsdValue);
  const hasRows = !isLoading && !hasError && events.length > 0;
  const showEmptyState = !isLoading && !hasError && events.length === 0;

  return (
    <Card>
      <ChangesHeader
        minimumUsdValue={minimumUsdValue}
        thresholdLabel={thresholdLabel}
        capped={hasRows || showEmptyState ? capped : false}
        eventCount={hasRows ? events.length : 0}
        unpricedEventsCount={hasRows ? unpricedEventsCount : 0}
        onMinimumUsdValueChange={onMinimumUsdValueChange}
        onMinimumUsdValueReset={onMinimumUsdValueReset}
      />
      <SupplyChangesContent
        events={events}
        minimumUsdValue={minimumUsdValue}
        thresholdLabel={thresholdLabel}
        isLoading={isLoading}
        hasError={hasError}
        capped={capped}
      />
    </Card>
  );
}

function SupplyChangesContent({
  events,
  minimumUsdValue,
  thresholdLabel,
  isLoading,
  hasError,
  capped,
}: {
  events: ReadonlyArray<StableSupplyChangeEvent>;
  minimumUsdValue: number;
  thresholdLabel: string;
  isLoading: boolean;
  hasError: boolean;
  capped: boolean;
}): React.JSX.Element {
  const reservedHeight = { minHeight: SUPPLY_CHANGES_RESERVED_HEIGHT_PX };

  if (isLoading) {
    return (
      <div style={reservedHeight}>
        <TableSkeleton variant="rows" rows={SUPPLY_CHANGES_SKELETON_ROWS} />
        <div className="mt-4 border-t border-slate-800 pt-4">
          <div className="h-4 w-48 animate-pulse rounded bg-slate-800/50" />
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div style={reservedHeight}>
        <p className="text-sm text-rose-400" role="alert">
          Failed to load supply changes.
        </p>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div style={reservedHeight}>
        <p className="text-sm text-slate-500">
          No supply changes at or above {thresholdLabel} equivalent in{" "}
          {capped ? "the most recent fetched rows" : "the selected window"}.
        </p>
      </div>
    );
  }

  const pageCountKey = Math.ceil(events.length / SUPPLY_CHANGES_PAGE_SIZE);
  return (
    <div style={reservedHeight}>
      <PaginatedSupplyChangesTable
        key={`${minimumUsdValue}:${pageCountKey}`}
        events={events}
      />
    </div>
  );
}

function PaginatedSupplyChangesTable({
  events,
}: {
  events: ReadonlyArray<StableSupplyChangeEvent>;
}): React.JSX.Element {
  const [pageIndex, setPageIndex] = useState(0);
  const pageCount = Math.max(
    1,
    Math.ceil(events.length / SUPPLY_CHANGES_PAGE_SIZE),
  );
  const currentPageIndex = Math.min(pageIndex, pageCount - 1);
  const pageStart = currentPageIndex * SUPPLY_CHANGES_PAGE_SIZE;
  const pageEvents = events.slice(
    pageStart,
    pageStart + SUPPLY_CHANGES_PAGE_SIZE,
  );

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500">
              <th className="py-2 pr-4">Time</th>
              <th className="py-2 pr-4">Token</th>
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4 text-right">Amount</th>
              <th className="py-2 pr-4">Caller</th>
              <th className="py-2">Tx</th>
            </tr>
          </thead>
          <tbody>
            {pageEvents.map((e) => (
              <SupplyChangeRow key={e.id} event={e} />
            ))}
          </tbody>
        </table>
      </div>
      <SupplyChangesPagination
        totalCount={events.length}
        pageStart={pageStart}
        visibleCount={pageEvents.length}
        currentPageIndex={currentPageIndex}
        pageCount={pageCount}
        onPrevious={() => setPageIndex((current) => Math.max(0, current - 1))}
        onNext={() =>
          setPageIndex((current) => Math.min(pageCount - 1, current + 1))
        }
      />
    </>
  );
}

function ChangesHeader({
  minimumUsdValue,
  thresholdLabel,
  capped,
  eventCount,
  unpricedEventsCount,
  onMinimumUsdValueChange,
  onMinimumUsdValueReset,
}: {
  minimumUsdValue: number;
  thresholdLabel: string;
  capped: boolean;
  eventCount: number;
  unpricedEventsCount: number;
  onMinimumUsdValueChange: (next: number) => void;
  onMinimumUsdValueReset: () => void;
}): React.JSX.Element {
  return (
    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <h2 className="text-lg font-semibold text-slate-100">Supply changes</h2>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between lg:justify-end">
        <SupplyChangeThresholdInput
          value={minimumUsdValue}
          onChange={onMinimumUsdValueChange}
          onReset={onMinimumUsdValueReset}
        />
        <div className="text-left sm:text-right">
          <p className="text-xs text-slate-500" role="status">
            Hiding changes below {thresholdLabel} equivalent.
          </p>
          {unpricedEventsCount > 0 ? (
            <p className="text-xs text-amber-400" role="status">
              Keeping {unpricedEventsCount} unpriced{" "}
              {unpricedEventsCount === 1 ? "event" : "events"} visible.
            </p>
          ) : null}
          {capped ? (
            <p className="text-xs text-amber-400" role="status">
              Showing {eventCount} matching events from the most recent fetched
              rows; older matches may be truncated.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SupplyChangesPagination({
  totalCount,
  pageStart,
  visibleCount,
  currentPageIndex,
  pageCount,
  onPrevious,
  onNext,
}: {
  totalCount: number;
  pageStart: number;
  visibleCount: number;
  currentPageIndex: number;
  pageCount: number;
  onPrevious: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const firstVisible = pageStart + 1;
  const lastVisible = pageStart + visibleCount;
  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-slate-800 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-slate-500" role="status">
        Showing {firstVisible}-{lastVisible} of {totalCount} matching events.
      </p>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrevious}
            disabled={currentPageIndex === 0}
            className="h-8 rounded-md border border-slate-700 px-3 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-slate-500">
            Page {currentPageIndex + 1} of {pageCount}
          </span>
          <button
            type="button"
            onClick={onNext}
            disabled={currentPageIndex >= pageCount - 1}
            className="h-8 rounded-md border border-slate-700 px-3 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SupplyChangeThresholdInput({
  value,
  onChange,
  onReset,
}: {
  value: number;
  onChange: (next: number) => void;
  onReset: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => String(value));

  // Draft text can be temporarily empty/invalid while `value` remains the
  // committed URL-backed number; sync only when back/reset changes `value`.
  // react-doctor-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    // react-doctor-disable-next-line effect/no-derived-state
    setDraft(String(value));
  }, [value]);

  const updateDraft = (nextDraft: string) => {
    if (/^\d*(?:\.\d*)?$/.test(nextDraft)) setDraft(nextDraft);
  };

  const commitDraft = () => {
    const next = parseThresholdDraft(draft);
    if (next == null) {
      setDraft(String(value));
      return;
    }
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  const restoreCommittedValue = () => {
    setDraft(String(value));
  };

  const resetDraft = () => {
    setDraft(String(DEFAULT_SUPPLY_CHANGE_MIN_USD));
    onReset();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commitDraft();
    } else if (event.key === "Escape") {
      restoreCommittedValue();
    }
  };

  return (
    <div className="min-w-[11rem]">
      <label
        htmlFor="supply-change-min-usd"
        className="mb-1 block text-xs text-slate-500"
      >
        Min value
      </label>
      <div className="flex items-center gap-1.5">
        <div className="flex h-8 items-center rounded-md border border-slate-700 bg-slate-950/60 focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500">
          <span className="pl-2 text-sm text-slate-500">$</span>
          <input
            id="supply-change-min-usd"
            type="text"
            inputMode="decimal"
            pattern="[0-9]*[.]?[0-9]*"
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={handleKeyDown}
            aria-label="Minimum USD-equivalent supply change"
            className="h-full w-24 bg-transparent px-1.5 text-sm text-slate-100 outline-none"
          />
        </div>
        <button
          type="button"
          onClick={resetDraft}
          disabled={value === DEFAULT_SUPPLY_CHANGE_MIN_USD}
          className="h-8 rounded-md border border-slate-700 px-2 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function parseThresholdDraft(draft: string): number | null {
  if (draft === "" || draft === "." || draft.endsWith(".")) return null;
  const next = Number(draft);
  return Number.isFinite(next) && next >= 0 ? next : null;
}

function SupplyChangeRow({
  event,
}: {
  event: StableSupplyChangeEvent;
}): React.JSX.Element {
  // Discriminate via the `kind` enum (authoritative) rather than the
  // leading minus sign on `amount` — a zero-value burn (rare, but legal)
  // would have `amount: "0"` and parse as mint by sign alone.
  const isMint = isMintKind(event.kind);
  // For display we strip the sign and color-code via the kind. `amount`
  // is signed token-native wei (+ for mint, − for burn).
  const absAmount = event.amount.startsWith("-")
    ? event.amount.slice(1)
    : event.amount;
  const formatted = formatWei(absAmount, event.tokenDecimals, 2);
  return (
    <tr className="border-t border-slate-800/70">
      <td
        className="py-3 pr-4 whitespace-nowrap"
        title={formatTimestamp(event.blockTimestamp)}
      >
        {relativeTime(event.blockTimestamp)}
      </td>
      <td className="py-3 pr-4 font-medium text-slate-100">
        {displayLabel(event.tokenSymbol, event.source)}
      </td>
      <td className="py-3 pr-4 text-slate-400">{kindLabel(event.kind)}</td>
      <td
        className={`py-3 pr-4 text-right font-mono ${isMint ? "text-emerald-300" : "text-rose-300"}`}
      >
        {isMint ? "+" : "−"}
        {formatted}
      </td>
      <td className="py-3 pr-4 text-slate-300">
        {event.isProtocolOwnedCaller ? (
          <span className="text-slate-500" title="Protocol-owned address">
            {truncateAddress(event.caller)}
          </span>
        ) : (
          <AddressLink address={event.caller} chainId={event.chainId} />
        )}
      </td>
      <td className="py-3 font-mono text-xs">
        <TxExplorerLink txHash={event.txHash} chainId={event.chainId} />
      </td>
    </tr>
  );
}

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      {children}
    </section>
  );
}

function TxExplorerLink({
  txHash,
  chainId,
}: {
  txHash: string;
  chainId: number;
}): React.JSX.Element {
  const networkId = networkIdForChainId(chainId);
  const network = networkId ? NETWORKS[networkId] : null;
  const short = truncateAddress(txHash);
  if (!network) {
    return (
      <span className="text-slate-400" title={txHash}>
        {short}
      </span>
    );
  }
  return (
    <a
      href={explorerTxUrl(network, txHash)}
      target="_blank"
      rel="noopener noreferrer"
      title={txHash}
      className="text-slate-300 hover:text-indigo-300 transition-colors"
    >
      {short}
    </a>
  );
}
