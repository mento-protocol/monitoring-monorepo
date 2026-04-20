"use client";

import { bridgeStatusLabel } from "@/lib/bridge-status";
import type { BridgeStatus } from "@/lib/types";

interface BridgeStatusFilterProps {
  /** All statuses the user can toggle. Order drives render order. */
  options: readonly BridgeStatus[];
  /**
   * Currently-selected statuses. Invariant: `selected` should be a subset
   * of `options` — values outside `options` aren't rendered as pills, but
   * the toggle now preserves them in the emitted array so a caller that
   * passes a transient superset (e.g. during an options-narrowing
   * migration) doesn't lose its state mid-toggle.
   */
  selected: readonly BridgeStatus[];
  onChange: (next: BridgeStatus[]) => void;
}

/**
 * Toggle-set of status pills above the transfers table. Multi-select —
 * clicking a pill flips that status in/out of the filter without touching
 * the others. An "All" shortcut resets the filter to include every option.
 *
 * Every option always stays visible (greyed-out when inactive) so the user
 * sees the full status vocabulary, not just the statuses that happen to be
 * in the current page of results.
 */
export function BridgeStatusFilter({
  options,
  selected,
  onChange,
}: BridgeStatusFilterProps) {
  const selectedSet = new Set(selected);
  const allSelected = options.every((s) => selectedSet.has(s));

  // Operate directly on `selected` — the old implementation rebuilt the
  // next array from `options`, which silently dropped any already-selected
  // value missing from `options` (e.g. after a status was removed from
  // ALL_BRIDGE_STATUSES). The pills still render in canonical order
  // because they're mapped from `options`; this only affects the array
  // emitted to the parent.
  const toggle = (status: BridgeStatus) => {
    onChange(
      selectedSet.has(status)
        ? selected.filter((s) => s !== status)
        : [...selected, status],
    );
  };

  const selectAll = () => onChange([...options]);

  return (
    <div
      role="group"
      aria-label="Filter transfers by status"
      className="flex flex-wrap items-center gap-1.5"
    >
      <span className="text-xs text-slate-500 mr-1">Status:</span>
      <button
        type="button"
        aria-pressed={allSelected}
        onClick={selectAll}
        className={
          "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
          (allSelected
            ? "bg-indigo-900/40 text-indigo-200"
            : "bg-slate-800 text-slate-400 hover:text-slate-200")
        }
      >
        All
      </button>
      {options.map((status) => {
        const active = selectedSet.has(status);
        return (
          <button
            key={status}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(status)}
            className={
              "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
              (active
                ? "bg-slate-700 text-slate-200"
                : "bg-slate-800/60 text-slate-500 hover:text-slate-300")
            }
          >
            {bridgeStatusLabel(status)}
          </button>
        );
      })}
    </div>
  );
}
