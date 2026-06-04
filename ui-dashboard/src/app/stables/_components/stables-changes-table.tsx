"use client";

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
import type { StableSupplyChangeEvent } from "../_lib/types";

type Props = {
  events: ReadonlyArray<StableSupplyChangeEvent>;
  isLoading: boolean;
  hasError: boolean;
  capped: boolean;
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
          No supply changes in the selected window.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-100">Supply changes</h2>
        {capped ? (
          <p className="text-xs text-amber-400" role="status">
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
        {event.isSystemCaller === true ? (
          <span className="text-slate-500" title="System contract">
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
