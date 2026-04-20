import type { ReactNode } from "react";
import type { SortDir } from "@/lib/table-sort";

interface SortableThProps<K extends string> {
  sortKey: K;
  activeSortKey: K;
  sortDir: SortDir;
  onSort: (key: K) => void;
  align?: "left" | "right";
  className?: string;
  children: ReactNode;
}

export function SortableTh<K extends string>({
  sortKey,
  activeSortKey,
  sortDir,
  onSort,
  align = "left",
  className = "",
  children,
}: SortableThProps<K>) {
  const isActive = sortKey === activeSortKey;
  const alignClass = align === "right" ? "text-right" : "text-left";
  const buttonAlign = align === "right" ? "justify-end ml-auto" : "";
  return (
    <th
      scope="col"
      aria-sort={
        isActive ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
      className={`px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 ${alignClass} whitespace-nowrap ${className}`}
    >
      <button
        type="button"
        className={`flex items-center gap-1 cursor-pointer select-none hover:text-slate-200 bg-transparent border-0 p-0 font-medium text-xs sm:text-sm text-slate-400 hover:text-slate-200 ${buttonAlign}`}
        onClick={() => onSort(sortKey)}
      >
        {children}
        {isActive ? (
          <span className="text-indigo-400">
            {sortDir === "asc" ? "↑" : "↓"}
          </span>
        ) : (
          <span
            className="text-slate-600 text-[1.1em] leading-none"
            style={{ fontVariantEmoji: "text" }}
          >
            ↕
          </span>
        )}
      </button>
    </th>
  );
}
