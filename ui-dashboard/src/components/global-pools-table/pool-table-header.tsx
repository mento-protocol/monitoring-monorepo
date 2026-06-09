import type { SortDir } from "@/lib/table-sort";
import { Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import type { GlobalSortKey } from "./sort";

interface PoolTableHeaderProps {
  sortKey: GlobalSortKey;
  sortDir: SortDir;
  onSort: (key: GlobalSortKey) => void;
  showVirtualPoolSource: boolean;
}

export function PoolTableHeader({
  sortKey,
  sortDir,
  onSort,
  showVirtualPoolSource,
}: PoolTableHeaderProps) {
  return (
    <thead>
      <tr className="border-b border-slate-800 bg-slate-900/50">
        <SortableTh
          sortKey="pool"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        >
          Pool
        </SortableTh>
        {showVirtualPoolSource && <Th>Type</Th>}
        <SortableTh
          sortKey="health"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        >
          Health
        </SortableTh>
        <SortableTh
          sortKey="uptime"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
          className="hidden sm:table-cell"
        >
          Uptime
        </SortableTh>
        <Th className="hidden sm:table-cell">Reserves</Th>
        <SortableTh
          sortKey="fee"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
          className="hidden sm:table-cell"
        >
          Fee
        </SortableTh>
        <SortableTh
          sortKey="tvl"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
          className="hidden sm:table-cell"
        >
          TVL
        </SortableTh>
        <SortableTh
          sortKey="volume7d"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
          className="hidden md:table-cell"
        >
          7d Vol.
        </SortableTh>
        <SortableTh
          sortKey="volume24h"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
          className="hidden xl:table-cell"
        >
          24h Vol.
        </SortableTh>
        <SortableTh
          sortKey="totalVolume"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
          className="hidden md:table-cell"
        >
          Total
        </SortableTh>
        <Th className="hidden 2xl:table-cell">Strategy</Th>
      </tr>
    </thead>
  );
}
