"use client";

// Sort state lives in the parent so a sort change can also reset pagination.

import React from "react";
import type { DeviationThresholdBreach } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { SortableTh } from "@/components/sortable-th";
import type { SortDir } from "@/lib/table-sort";
import { BreachRow } from "./breach-row";

/** Columns the user can sort on server-side. */
export type SortKey =
  | "startedAt"
  | "durationSeconds"
  | "criticalDurationSeconds"
  | "peakPriceDifference";

export function BreachTable({
  rows,
  network,
  getName,
  sortKey,
  sortDir,
  onSort,
}: {
  rows: DeviationThresholdBreach[];
  network: Network;
  getName: (addr: string | null, chainId?: number) => string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <SortableTh
              sortKey="startedAt"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            >
              Started
            </SortableTh>
            <SortableTh
              sortKey="durationSeconds"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            >
              Duration
            </SortableTh>
            <SortableTh
              sortKey="criticalDurationSeconds"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            >
              Past grace
            </SortableTh>
            <SortableTh
              sortKey="peakPriceDifference"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              align="right"
            >
              Peak
            </SortableTh>
            <th className="py-2 pr-4 font-normal">Trigger</th>
            <th className="py-2 pr-4 font-normal">Ended by</th>
            <th className="py-2 pr-4 font-normal text-right">Rebalances</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <BreachRow
              key={b.id}
              breach={b}
              network={network}
              getName={getName}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
