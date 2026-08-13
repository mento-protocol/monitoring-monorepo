"use client";

import { Fragment, useCallback, useState } from "react";
import type { PegMonitoringPresentation } from "@/lib/peg-monitoring-presentation";
import {
  PEG_BOARD_GRID,
  PEG_BOARD_MIN_WIDTH,
  sortBoardRows,
} from "../_lib/peg-board-model";
import { BoardRow } from "./board-row";
import { RowPanel } from "./row-panel";

const HEADERS = [
  "Peg",
  "Status",
  "Price",
  "Distance to target",
  "Primary market",
  "Bid-ask spread",
  "Trading limit",
  "Breaker",
  "",
];

export function BoardTable({
  presentation,
  nowMs,
  producedAt,
  stale,
  previousPolicy,
  ageLabel,
}: {
  presentation: PegMonitoringPresentation;
  nowMs: number;
  producedAt: number;
  stale: boolean;
  previousPolicy: boolean;
  ageLabel: string;
}): React.JSX.Element {
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const toggleRow = useCallback((assetId: string) => {
    setOpenRows((current) => {
      const next = new Set(current);
      if (!next.delete(assetId)) next.add(assetId);
      return next;
    });
  }, []);
  const rows = sortBoardRows(presentation.assets);
  return (
    <div data-testid="peg-board" className="border border-border">
      <div className="overflow-x-auto">
        <div className={PEG_BOARD_MIN_WIDTH}>
          <div
            className={`grid border-b border-border px-[18px] py-2.5 ${PEG_BOARD_GRID}`}
          >
            {HEADERS.map((header, index) => (
              <div
                key={header === "" ? `spacer-${index}` : header}
                className="whitespace-nowrap text-[10.5px] font-[650] uppercase tracking-[0.1em] text-muted-foreground"
              >
                {header}
              </div>
            ))}
          </div>
          {rows.map((asset) => {
            const open = openRows.has(asset.asset.asset);
            // Retained evidence keeps its confirmed structural result rather
            // than expiring against the moving browser clock.
            const structuralCurrent = stale || asset.structuralEvidenceCurrent;
            return (
              <Fragment key={asset.asset.asset}>
                <BoardRow
                  asset={asset}
                  nowMs={nowMs}
                  producedAt={producedAt}
                  stale={stale}
                  structuralCurrent={structuralCurrent}
                  open={open}
                  onToggle={toggleRow}
                />
                {open ? (
                  <RowPanel
                    asset={asset}
                    nowMs={nowMs}
                    producedAt={producedAt}
                    stale={stale}
                    previousPolicy={previousPolicy}
                    ageLabel={ageLabel}
                    structuralCurrent={structuralCurrent}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
