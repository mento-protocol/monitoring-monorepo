"use client";

import {
  formatPair,
  MiniBar,
  type WindowSummary,
} from "@/components/pool-header/limit-mini-bar";
import {
  brokerLegCoverage,
  enabledWindows,
  worstBrokerRow,
  type BrokerLimitWindow,
  type BrokerLimitsState,
} from "@/lib/broker-limits";
import type { Network } from "@/lib/networks";
import { tokenSymbol } from "@/lib/tokens";
import type { Pool } from "@/lib/types";

const SHORT_KEY: Record<BrokerLimitWindow["key"], string> = {
  global: "LG",
  l0: "L0",
  l1: "L1",
};

// Tailwind needs literal class names, so map the 1–3 enabled windows to one.
const GRID_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
};

function summarize(window: BrokerLimitWindow): WindowSummary {
  return {
    pressure: Number(window.pressure) || 0,
    netflow: Math.abs(Number(window.netflow) || 0),
    limit: Number(window.limit) || 0,
  };
}

/**
 * Header tile for a VirtualPool: the wrapped v2 exchange's tightest token leg,
 * one mini-bar per enabled Broker window. Values are whole token units, so the
 * compact pair is formatted directly rather than through the 15-decimal FPMM
 * scale.
 */
export function BrokerLimitStatusValue({
  pool,
  network,
  state,
}: {
  pool: Pool;
  network: Network;
  state: BrokerLimitsState;
}) {
  // One stable live region wraps every branch. The branches replace each other
  // as the query resolves, so a role on each would be torn down before a
  // screen reader could announce it.
  return (
    <span role="status" aria-live="polite" className="block">
      <BrokerLimitStatusBody pool={pool} network={network} state={state} />
    </span>
  );
}

/** Names the legs the Broker has not read yet, in the degraded-note voice the
 *  Limits tab uses. */
function partialReadTitle(network: Network, pending: string[]): string {
  const symbols = pending.map((token) => tokenSymbol(network, token));
  const subject =
    symbols.length === 1
      ? `the ${symbols[0]} leg has`
      : `the ${symbols.join(" and ")} legs have`;
  return `Partial read — ${subject} no Broker reading yet; the next swap on this exchange records it.`;
}

function BrokerLimitStatusBody({
  pool,
  network,
  state,
}: {
  pool: Pool;
  network: Network;
  state: BrokerLimitsState;
}) {
  if (state.hasError) {
    return <span className="text-xs text-amber-400">Query failed</span>;
  }
  // Skeleton parity: reserve the loaded tile's two stacked rows — the mini-bar
  // row and the compact pair — so the header grid does not grow when the query
  // resolves. `invisible` keeps the slot without announcing an empty tile, the
  // same treatment the Oracle Price tile uses.
  if (state.isLoading && state.rows.length === 0) {
    return (
      <span className="invisible flex flex-col gap-0.5 w-full max-w-52">
        <span className="h-5" />
        <span className="text-xs font-mono">—</span>
      </span>
    );
  }

  // The tile summarises the pool, so a leg the Broker has not read holds it at
  // the partial state. Presenting the readable leg as "the tightest" would hide
  // an unread sibling that may already be critical — the same rule
  // `foldPoolLimitFields` applies in the indexer.
  const coverage = brokerLegCoverage(state.rows, pool.token0, pool.token1);
  if (!coverage.complete) {
    return (
      <span
        className="text-slate-500"
        title={
          coverage.pending.length > 0
            ? partialReadTitle(network, coverage.pending)
            : undefined
        }
      >
        —
      </span>
    );
  }

  const row = worstBrokerRow(state.rows);
  const windows = row?.stateKnown ? enabledWindows(row) : [];
  if (windows.length === 0) {
    return <span className="text-slate-500">—</span>;
  }

  const columns = GRID_COLUMNS[windows.length] ?? "grid-cols-3";
  // Cap the tile width instead of fixing it: the header grid drops to two
  // columns at phone width, where a fixed 13rem tile overflows the viewport.
  return (
    <span className="flex flex-col gap-0.5 w-full max-w-52">
      <span className={`grid ${columns} gap-2 h-5 items-center`}>
        {windows.map((window) => (
          <MiniBar
            key={window.key}
            summary={summarize(window)}
            title={window.label}
          />
        ))}
      </span>
      <span
        className={`grid ${columns} gap-2 text-xs text-slate-500 font-mono`}
      >
        {windows.map((window) => (
          <span key={window.key} title={`${window.label} netflow / limit`}>
            <span className="text-slate-600">{SHORT_KEY[window.key]} </span>
            {formatPair(summarize(window))}
          </span>
        ))}
      </span>
    </span>
  );
}
