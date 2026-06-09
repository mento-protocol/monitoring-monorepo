import { formatUSD, formatWei } from "@/lib/format";
import { computeReserveComposition } from "@/lib/reserves";
import type { Network } from "@/lib/networks";
import type { OracleRateMap } from "@/lib/tokens";
import type { Pool } from "@/lib/types";

export function ReservesCell({
  pool,
  network,
  rates,
}: {
  pool: Pool;
  network: Network;
  rates: OracleRateMap;
}) {
  const composition = computeReserveComposition(pool, network, rates);

  if (composition.kind !== "available") {
    return (
      <span
        className={`text-xs ${composition.kind === "empty" ? "text-slate-500" : "text-slate-600"}`}
        title={unavailableMessage(composition.kind)}
      >
        {composition.kind === "empty" ? "Empty" : "—"}
      </span>
    );
  }

  const label = `Reserve composition: ${composition.pct0.toFixed(1)}% ${composition.symbol0} / ${composition.pct1.toFixed(1)}% ${composition.symbol1}`;
  const title = [
    label,
    `${composition.symbol0}: ${formatWei(pool.reserves0!, pool.token0Decimals ?? 18, 2)} ≈ ${formatUSD(composition.usd0)}`,
    `${composition.symbol1}: ${formatWei(pool.reserves1!, pool.token1Decimals ?? 18, 2)} ≈ ${formatUSD(composition.usd1)}`,
  ].join("\n");

  return (
    <div
      className="min-w-[7.5rem] max-w-[10rem]"
      aria-label={label}
      title={title}
    >
      <div
        className="mb-1 flex h-2 overflow-hidden rounded-full bg-slate-800 ring-1 ring-inset ring-slate-700/80"
        aria-hidden="true"
      >
        <span
          className="block h-full bg-indigo-500"
          style={{ width: `${composition.pct0}%` }}
        />
        <span
          className="block h-full bg-emerald-500"
          style={{ width: `${composition.pct1}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] leading-tight text-slate-300">
        <span className="truncate">
          {composition.symbol0} {composition.pct0.toFixed(0)}%
        </span>
        <span className="truncate text-right">
          {composition.symbol1} {composition.pct1.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

function unavailableMessage(
  kind: Exclude<
    ReturnType<typeof computeReserveComposition>["kind"],
    "available"
  >,
): string {
  switch (kind) {
    case "untrusted-decimals":
      return "Reserves hidden until token decimals are verified.";
    case "missing":
      return "No reserve data available yet.";
    case "empty":
      return "Pool has no reserves yet.";
    case "unpriceable":
      return "Reserves pricing unavailable for this pair.";
  }
}
