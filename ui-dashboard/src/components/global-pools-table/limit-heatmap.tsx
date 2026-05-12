import { pressureColorClass } from "@/lib/health";
import type { Network } from "@/lib/networks";
import { tokenSymbol } from "@/lib/tokens";
import type { Pool, TradingLimit } from "@/lib/types";

// Compact 2×2 limit heatmap

export function LimitHeatmap({
  limits,
  network,
  pool,
}: {
  limits: TradingLimit[];
  network: Network;
  pool: Pool;
}) {
  if (limits.length === 0)
    return <span className="text-slate-600 text-xs">—</span>;

  // Order by the pool's token0/token1 so heatmap rows match the displayed pair
  // ES2023 `toSorted` requires Safari 16+/Chrome 110+; TS target is
  // ES2017 with no polyfill — keep the spread+sort form (codex P2).
  // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
  const sorted = [...limits].sort((a, b) => {
    const aIdx = a.token.toLowerCase() === pool.token0?.toLowerCase() ? 0 : 1;
    const bIdx = b.token.toLowerCase() === pool.token0?.toLowerCase() ? 0 : 1;
    return aIdx - bIdx;
  });
  const rows = sorted.map((tl) => {
    const p0 = Number(tl.limitPressure0); // L0 = 5min
    const p1 = Number(tl.limitPressure1); // L1 = 24h
    const sym = tokenSymbol(network, tl.token);
    return { sym, p0, p1 };
  });

  const tooltip = rows
    .map(
      (r) =>
        `${r.sym}: 5m ${(r.p0 * 100).toFixed(1)}% · 24h ${(r.p1 * 100).toFixed(1)}%`,
    )
    .join("\n");

  return (
    /* eslint-disable jsx-a11y/no-noninteractive-tabindex */
    // Focusable for keyboard tooltip access, not an interactive control
    <span
      className="inline-grid grid-cols-2 gap-px rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
      tabIndex={0}
      role="group"
      aria-label={tooltip.replace(/\n/g, "; ")}
      title={tooltip}
    >
      {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
      {rows.map((r) => (
        <span key={r.sym} className="contents">
          <span
            className={`block w-2 h-2 rounded-sm ${pressureColorClass(r.p0)}`}
            aria-hidden="true"
          />
          <span
            className={`block w-2 h-2 rounded-sm ${pressureColorClass(r.p1)}`}
            aria-hidden="true"
          />
        </span>
      ))}
    </span>
  );
}
