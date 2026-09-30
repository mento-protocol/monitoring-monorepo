"use client";

import { createContext, use, type ReactNode } from "react";

/** Optional controls rendered beside the active table's search input. */
export const TableControlsContext = createContext<ReactNode>(null);

/** Keep page size usable when the table cannot render its search toolbar. */
export function TableControlsFallback({ children }: { children?: ReactNode }) {
  const controls = use(TableControlsContext);
  return (
    <>
      {controls && <div className="mb-4 flex justify-end">{controls}</div>}
      {children}
    </>
  );
}
