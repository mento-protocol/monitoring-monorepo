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
      <SortableTh
        sortKey="rank"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
        trailing={
          <Tooltip
            label="About redemption rank"
            content={RANK_EXPLAINER}
            align="left"
          >
            <span className="text-slate-500" aria-hidden="true">
              ⓘ
            </span>
          </Tooltip>
        }
      >
        Rank
      </SortableTh>
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
      <SortableTh
        sortKey="icr"
        activeSortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        align="right"
        trailing={
          <Tooltip
            label="About indexed ICR"
            content={ICR_INDEXED_EXPLAINER}
            align="right"
          >
            <span className="text-slate-500" aria-hidden="true">
              ⓘ
            </span>
          </Tooltip>
        }
      >
        ICR (indexed)
      </SortableTh>
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
