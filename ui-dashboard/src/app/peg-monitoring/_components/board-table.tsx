"use client";

import { Fragment, useCallback, useState } from "react";
import type { PegMonitoringPresentation } from "@/lib/peg-monitoring-presentation";
import {
  PEG_BOARD_GRID,
  PEG_BOARD_MIN_WIDTH,
  PEG_BOARD_ROW_PADDING,
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
  policyVersion,
}: {
  presentation: PegMonitoringPresentation;
  nowMs: number;
  producedAt: number;
  stale: boolean;
  previousPolicy: boolean;
  ageLabel: string;
  policyVersion: string;
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
      {/* `relative` contains absolutely-positioned descendants (the sr-only
          column label, rail markers) so they clip with the scroller instead of
          widening the document on narrow viewports. */}
      <div
        data-testid="peg-board-scroller"
        className="relative overflow-x-auto"
      >
        {/* The layout is a CSS grid, so the table semantics screen readers
            need for column/cell association are declared via ARIA roles; the
            expanded panel participates as a full-width row (aria-colspan). */}
        <div
          role="table"
          aria-label="Peg monitoring board"
          className={PEG_BOARD_MIN_WIDTH}
        >
          <div
            role="row"
            className={`grid border-b border-border py-2.5 ${PEG_BOARD_GRID} ${PEG_BOARD_ROW_PADDING}`}
          >
            {HEADERS.map((header, index) => (
              <div
                role="columnheader"
                key={header === "" ? `spacer-${index}` : header}
                className="whitespace-nowrap text-[10.5px] font-[650] uppercase tracking-[0.1em] text-muted-foreground"
              >
                {/* axe's empty-table-header wants SR-visible text, not a
                    label attribute, for the chevron column. */}
                {header === "" ? (
                  <span className="sr-only">Details</span>
                ) : (
                  header
                )}
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
                    policyVersion={policyVersion}
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
