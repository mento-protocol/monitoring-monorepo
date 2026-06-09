import type { ReactNode } from "react";
import { SortableTh } from "@/components/sortable-th";
import { Row, Th } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import type { SortDir } from "@/lib/table-sort";
import type { HistorySortKey, OpenSortKey, TroveSortKey } from "./trove-sort";

const ICR_INDEXED_EXPLAINER = (
  <>
    Individual Collateral Ratio (
    <code className="rounded bg-slate-900 px-1 font-mono text-[11px] text-slate-100">
      coll. / debt
    </code>
    ) snapshot from the latest indexed trove event, not a live oracle/RPC read.
  </>
);
const RANK_EXPLAINER =
  "Redemption priority. Troves are redeemed against in ascending interest-rate order — rank #1 is the lowest-rate trove and is redeemed first. Troves sharing a rate share a rank (shown as a tie).";

export function OpenTroveHeader({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: OpenSortKey;
  sortDir: SortDir;
  onSort: (key: TroveSortKey) => void;
}) {
  return (
    <Row>
      <SortableInfoTh
        sortKey="rank"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        info={RANK_EXPLAINER}
        infoLabel="About redemption rank"
        infoAlign="left"
      >
        Rank
      </SortableInfoTh>
      <Th>Owner / Trove</Th>
      <Th>Status</Th>
      <SortableTh
        sortKey="debt"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Debt
      </SortableTh>
      <SortableTh
        sortKey="collateral"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Collateral
      </SortableTh>
      <SortableInfoTh
        sortKey="icr"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        info={ICR_INDEXED_EXPLAINER}
        infoLabel="About indexed ICR"
        infoAlign="right"
      >
        ICR (indexed)
      </SortableInfoTh>
      <SortableTh
        sortKey="interest"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Interest
      </SortableTh>
      <SortableTh
        sortKey="updated"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Updated
      </SortableTh>
    </Row>
  );
}

export function HistoryTroveHeader({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: HistorySortKey;
  sortDir: SortDir;
  onSort: (key: TroveSortKey) => void;
}) {
  return (
    <Row>
      <Th>Last owner / Trove</Th>
      <Th>Status</Th>
      <SortableTh
        sortKey="opened"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Opened
      </SortableTh>
      <SortableTh
        sortKey="ended"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Ended / Updated
      </SortableTh>
      <SortableTh
        sortKey="remainingColl"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Remaining collateral
      </SortableTh>
      <SortableTh
        sortKey="redeemed"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Redeemed
      </SortableTh>
      <SortableTh
        sortKey="redemptionFee"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Redemption fee
      </SortableTh>
      <SortableTh
        sortKey="liquidated"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
      >
        Liquidated
      </SortableTh>
    </Row>
  );
}

/**
 * Right-aligned sortable header with an adjacent info tooltip. The tooltip
 * trigger is a sibling of the sort button — never nested inside it — because
 * the tooltip renders its own `<button>` and nesting interactive controls is
 * invalid markup the a11y suite would flag.
 */
function SortableInfoTh<K extends string>({
  sortKey,
  activeSortKey,
  sortDir,
  onSort,
  info,
  infoLabel,
  infoAlign,
  children,
}: {
  sortKey: K;
  activeSortKey: K;
  sortDir: SortDir;
  onSort: (key: K) => void;
  info: ReactNode;
  infoLabel: string;
  infoAlign: "left" | "right";
  children: ReactNode;
}) {
  const isActive = sortKey === activeSortKey;
  return (
    <th
      scope="col"
      aria-sort={
        isActive ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
      className="whitespace-nowrap px-2 py-2 text-right text-xs font-medium text-slate-400 sm:px-4 sm:py-3 sm:text-sm"
    >
      <span className="inline-flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className="flex cursor-pointer select-none items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium text-slate-400 hover:text-slate-200 sm:text-sm"
        >
          {children}
          {isActive ? (
            <span className="text-indigo-400">
              {sortDir === "asc" ? "↑" : "↓"}
            </span>
          ) : (
            <span
              className="text-[1.1em] leading-none text-slate-600"
              style={{ fontVariantEmoji: "text" }}
            >
              ↕
            </span>
          )}
        </button>
        <Tooltip label={infoLabel} content={info} align={infoAlign}>
          <span className="text-slate-500" aria-hidden="true">
            ⓘ
          </span>
        </Tooltip>
      </span>
    </th>
  );
}
