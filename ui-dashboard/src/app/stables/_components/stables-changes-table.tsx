"use client";

import { useEffect, useState } from "react";
import { AddressLink } from "@/components/address-link";
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
  if (isLoading) {
    return (
      <Card>
        <ChangesHeader
          minimumUsdValue={minimumUsdValue}
          thresholdLabel={thresholdLabel}
          capped={false}
          eventCount={0}
          unpricedEventsCount={0}
          onMinimumUsdValueChange={onMinimumUsdValueChange}
          onMinimumUsdValueReset={onMinimumUsdValueReset}
        />
        <p className="text-sm text-slate-500">Loading supply changes…</p>
      </Card>
    );
  }
  if (hasError) {
    return (
      <Card>
        <ChangesHeader
          minimumUsdValue={minimumUsdValue}
          thresholdLabel={thresholdLabel}
          capped={false}
          eventCount={0}
          unpricedEventsCount={0}
          onMinimumUsdValueChange={onMinimumUsdValueChange}
          onMinimumUsdValueReset={onMinimumUsdValueReset}
        />
        <p className="text-sm text-rose-400" role="alert">
          Failed to load supply changes.
        </p>
      </Card>
    );
  }
  if (events.length === 0) {
    return (
      <Card>
        <ChangesHeader
          minimumUsdValue={minimumUsdValue}
          thresholdLabel={thresholdLabel}
          capped={capped}
          eventCount={0}
          unpricedEventsCount={0}
          onMinimumUsdValueChange={onMinimumUsdValueChange}
          onMinimumUsdValueReset={onMinimumUsdValueReset}
        />
        <p className="text-sm text-slate-500">
          No supply changes at or above {thresholdLabel} equivalent in{" "}
          {capped ? "the most recent fetched rows" : "the selected window"}.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <ChangesHeader
        minimumUsdValue={minimumUsdValue}
        thresholdLabel={thresholdLabel}
        capped={capped}
        eventCount={events.length}
        unpricedEventsCount={unpricedEventsCount}
        onMinimumUsdValueChange={onMinimumUsdValueChange}
        onMinimumUsdValueReset={onMinimumUsdValueReset}
      />
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
            {events.map((e) => (
              <SupplyChangeRow key={e.id} event={e} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
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
          <p className="text-xs text-slate-500">
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
              Showing the most recent {eventCount} events; older entries may be
              truncated.
            </p>
          ) : null}
        </div>
      </div>
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
