"use client";

import { createContext, type ReactNode } from "react";

/** Optional controls rendered beside the active table's search input. */
export const TableControlsContext = createContext<ReactNode>(null);
