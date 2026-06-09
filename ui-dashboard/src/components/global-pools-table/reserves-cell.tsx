import { formatUSD, formatWei } from "@/lib/format";
import { computeReserveComposition } from "@/lib/reserves";
import type { Network } from "@/lib/networks";
import { poolTokenDisplayOrder, type OracleRateMap } from "@/lib/tokens";
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

  const displayOrder = poolTokenDisplayOrder(network, pool.token0, pool.token1);
  const parts = [
    {
      symbol: composition.symbol0,
      pct: composition.pct0,
      rawReserve: pool.reserves0!,
      decimals: pool.token0Decimals ?? 18,
      usd: composition.usd0,
    },
    {
      symbol: composition.symbol1,
      pct: composition.pct1,
      rawReserve: pool.reserves1!,
      decimals: pool.token1Decimals ?? 18,
      usd: composition.usd1,
    },
  ] as const;
  const first = parts[displayOrder.firstIndex];
  const second = parts[displayOrder.secondIndex];

  const label = `Reserve composition: ${first.pct.toFixed(1)}% ${first.symbol} / ${second.pct.toFixed(1)}% ${second.symbol}`;
  const title = [
    label,
    `${first.symbol}: ${formatWei(first.rawReserve, first.decimals, 2)} ≈ ${formatUSD(first.usd)}`,
    `${second.symbol}: ${formatWei(second.rawReserve, second.decimals, 2)} ≈ ${formatUSD(second.usd)}`,
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
          style={{ width: `${first.pct}%` }}
        />
        <span
          className="block h-full bg-emerald-500"
          style={{ width: `${second.pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] leading-tight text-slate-300">
        <span className="truncate">
          {first.symbol} {first.pct.toFixed(0)}%
        </span>
        <span className="truncate text-right">
          {second.symbol} {second.pct.toFixed(0)}%
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
