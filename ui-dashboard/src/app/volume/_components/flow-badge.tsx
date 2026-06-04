"use client";

import type { FlowResult } from "@/lib/volume";

/**
 * Visualizes a trader's flow in their primary pool:
 *   one-directional → 🡆 (extractive arb / corridor flow)
 *   delta-neutral   → ⇌ (round-tripping, MM-like)
 *   mixed           → ⤺
 *
 * The imbalance score is rendered as visible text (`+87% USDC`, `2%`, etc.)
 * — earlier versions kept it behind the `title` attribute, which left
 * keyboard, touch, and many screen-reader users with no access to the
 * quantitative meaning of the badge (cursor finding 3184000783).
 */
export function FlowBadge({
  flow,
  token0Symbol,
  token1Symbol,
}: {
  flow: FlowResult;
  token0Symbol?: string | null;
  token1Symbol?: string | null;
}) {
  const pct = `${(flow.imbalance * 100).toFixed(0)}%`;
  if (flow.kind === "one-directional") {
    const accumulated =
      flow.direction === 0
        ? token0Symbol
        : flow.direction === 1
          ? token1Symbol
          : null;
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
        title={`Imbalance ${pct} — net accumulating ${accumulated ?? "one token"}`}
      >
        <span aria-hidden="true">🡆</span>
        {accumulated ? `+${pct} ${accumulated}` : `${pct} 1-way`}
      </span>
    );
  }
  if (flow.kind === "delta-neutral") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
        title={`Imbalance ${pct} — flows roughly cancel out`}
      >
        <span aria-hidden="true">⇌</span>
        {pct} round-trip
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] font-medium text-slate-300"
      title={`Imbalance ${pct}`}
    >
      <span aria-hidden="true">⤺</span>
      {pct} mixed
    </span>
  );
}
