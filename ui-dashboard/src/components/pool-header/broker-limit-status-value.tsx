"use client";

import {
  formatPair,
  MiniBar,
  type WindowSummary,
} from "@/components/pool-header/limit-mini-bar";
import {
  enabledWindows,
  worstBrokerRow,
  type BrokerLimitWindow,
  type BrokerLimitsState,
} from "@/lib/broker-limits";

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
  state,
}: {
  state: BrokerLimitsState;
}) {
  if (state.hasError) {
    return <span className="text-xs text-amber-400">Query failed</span>;
  }
  // Hold the grid slot without announcing an empty tile while the first
  // request is in flight — the Oracle Price tile uses the same placeholder.
  if (state.isLoading && state.rows.length === 0) {
    return <span className="invisible">—</span>;
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
