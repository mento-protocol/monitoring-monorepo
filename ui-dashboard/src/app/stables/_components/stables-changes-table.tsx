"use client";

import { AddressLink } from "@/components/address-link";
import {
  formatTimestamp,
  formatWei,
  relativeTime,
  truncateAddress,
} from "@/lib/format";
import { displayLabel, kindLabel } from "@/lib/stables";
import type { V2StableSupplyChangeEvent } from "../_lib/types";

const CELO_CHAIN_ID = 42220;

type Props = {
  events: ReadonlyArray<V2StableSupplyChangeEvent>;
  isLoading: boolean;
  hasError: boolean;
  capped: boolean;
};

/**
 * V2 supply-changes table — every Transfer-with-zero on the subscribed
 * stables, labeled by kind (RESERVE_MINT / BRIDGE_BURN / etc) and linked
 * to the on-chain tx + caller address.
 *
 * V3 Liquity CDP mint/burn events (TroveOperationEvent / RedemptionEvent /
 * LiquidationEvent) are deferred to PR2.5 — they carry source-specific
 * fields that need a richer per-row layout.
 */
export function StablesChangesTable({
  events,
  isLoading,
  hasError,
  capped,
}: Props): React.JSX.Element {
  if (isLoading) {
    return (
      <Card>
        <p className="text-sm text-slate-500">Loading supply changes…</p>
      </Card>
    );
  }
  if (hasError) {
    return (
      <Card>
        <p className="text-sm text-rose-400" role="alert">
          Failed to load supply changes.
        </p>
      </Card>
    );
  }
  if (events.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-500">
          No V2 supply changes in the selected window.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-100">Supply changes</h2>
        {capped ? (
          <p className="text-xs text-amber-400">
            Showing the most recent {events.length} events — older entries may
            be truncated.
          </p>
        ) : null}
      </div>
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

function SupplyChangeRow({
  event,
}: {
  event: V2StableSupplyChangeEvent;
}): React.JSX.Element {
  const isMint = event.amount.startsWith("-") === false;
  // `amount` arrives signed (+ mint / − burn). For display we strip the sign
  // and color-code via the kind enum so the table reads at a glance.
  const absAmount = event.amount.startsWith("-")
    ? event.amount.slice(1)
    : event.amount;
  // Token decimals aren't on the V2StableSupplyChangeEvent row — every V2
  // stable in the registry today is 18 decimals (verified in config.ts).
  // Hardcoding 18 keeps the table fast; a per-row decimals join can land
  // when a non-18-decimal Mento stable ships.
  const formatted = formatWei(absAmount, 18, 2);
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
        {event.isSystemCaller ? (
          <span className="text-slate-500" title="System contract">
            {truncateAddress(event.caller)}
          </span>
        ) : (
          <AddressLink address={event.caller} chainId={CELO_CHAIN_ID} />
        )}
      </td>
      <td className="py-3 font-mono text-xs text-slate-400">
        {truncateAddress(event.txHash)}
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
