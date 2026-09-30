"use client";

import type { ReactNode } from "react";
import { LimitSelect } from "@/components/controls";
import { TableControlsContext } from "@/components/table-controls-context";
import { TABS_WITHOUT_LIMIT_SELECT, type Tab } from "../_lib/constants";

export function PoolTableControls({
  tab,
  limit,
  onLimitChange,
  children,
}: {
  tab: Tab;
  limit: number;
  onLimitChange: (limit: number) => void;
  children: ReactNode;
}) {
  return (
    <TableControlsContext.Provider
      value={
        TABS_WITHOUT_LIMIT_SELECT.has(tab) ? null : (
          <LimitSelect
            id="tab-limit"
            label="Rows per page"
            value={limit}
            onChange={onLimitChange}
          />
        )
      }
    >
      {children}
    </TableControlsContext.Provider>
  );
}
