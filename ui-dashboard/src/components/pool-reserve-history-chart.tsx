"use client";

import { useState } from "react";
import { ReserveChart } from "@/components/reserve-chart";
import { usePoolReserveHistory } from "@/hooks/use-pool-reserve-history";
import {
  RESERVE_HISTORY_RANGES,
  type ReserveHistoryRange,
  type ReserveHistory,
} from "@/lib/pool-reserve-history";
import type { Pool } from "@/lib/types";

function historyTimeWindow(
  data: ReserveHistory | undefined,
  range: ReserveHistoryRange,
): [number, number] | undefined {
  if (!data) return undefined;
  // All starts at the first observed event, rather than Unix epoch.
  const from =
    range === "All" && data.rows.length
      ? Number(data.rows[0]!.blockTimestamp)
      : data.from;
  return [from, data.to];
}

function historyErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error.message : String(error);
}

export function PoolReserveHistoryChart({
  poolId,
  pool,
}: {
  poolId: string;
  pool: Pool | null;
}) {
  const [range, setRange] = useState<ReserveHistoryRange>("1d");
  const { data, error, isLoading } = usePoolReserveHistory(poolId, range);
  const controls = (
    <div
      role="group"
      aria-label="Reserve history time range"
      className="mb-2 flex w-fit gap-0.5 rounded-md bg-slate-800/50 p-0.5"
    >
      {RESERVE_HISTORY_RANGES.map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={range === item}
          onClick={() => setRange(item)}
          className={
            "rounded px-3 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
            (range === item
              ? "bg-slate-700 text-white"
              : "text-slate-400 hover:text-slate-200")
          }
        >
          {item}
        </button>
      ))}
    </div>
  );
  return (
    <ReserveChart
      rows={data?.rows ?? []}
      pool={pool}
      token0={pool?.token0 ?? null}
      token1={pool?.token1 ?? null}
      controls={controls}
      timeWindow={historyTimeWindow(data, range)}
      isLoading={isLoading}
      error={historyErrorMessage(error)}
      truncated={data?.truncated ?? false}
    />
  );
}
