"use client";

import { bridgeStatusLabel } from "@/lib/bridge-status";
import type { BridgeStatus } from "@/lib/types";

interface BridgeStatusFilterProps {
  options: readonly BridgeStatus[];
  /** null = ALL selected (default). One status = that filter is active. */
  selected: BridgeStatus | null;
  onChange: (next: BridgeStatus | null) => void;
}

/**
 * Radio-style status filter. Exactly one option is active at a time:
 * "All" (null) or a single status. Inactive pills are visually dimmed
 * but remain clickable — clicking any pill switches directly to it.
 */
export function BridgeStatusFilter({
  options,
  selected,
  onChange,
}: BridgeStatusFilterProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Filter transfers by status"
      className="flex flex-wrap items-center gap-1.5"
    >
      <span className="text-xs text-slate-500 mr-1">Status:</span>
      <button
        type="button"
        role="radio"
        aria-checked={selected === null}
        onClick={() => selected !== null && onChange(null)}
        className={
          "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
          (selected === null
            ? "bg-indigo-900/40 text-indigo-200"
            : "bg-slate-800/60 text-slate-400 hover:text-slate-200")
        }
      >
        All
      </button>
      {options.map((status) => {
        const active = selected === status;
        return (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => !active && onChange(status)}
            className={
              "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
              (active
                ? "bg-slate-700 text-slate-200"
                : "bg-slate-800/60 text-slate-400 hover:text-slate-200")
            }
          >
            {bridgeStatusLabel(status)}
          </button>
        );
      })}
    </div>
  );
}
