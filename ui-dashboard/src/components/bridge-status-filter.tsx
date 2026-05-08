"use client";

import { bridgeStatusDetailLabel } from "@/lib/bridge-status";
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
 *
 * Implements the WAI-ARIA radiogroup keyboard contract:
 * - Single tab stop: `tabIndex={0}` on the selected pill, `tabIndex={-1}`
 *   on all others.
 * - Arrow keys (Left/Right/Up/Down) move focus AND change selection
 *   (radiogroup convention: focus and selection move together).
 * - Home / End jump to first / last option (and select it).
 * - Space/Enter activate the focused pill (native `<button>` behavior).
 *
 * Pill index map: 0 = "All" (`null`), 1..N = `options[i - 1]`.
 */
export function BridgeStatusFilter({
  options,
  selected,
  onChange,
}: BridgeStatusFilterProps) {
  // Index in the radio sequence that should hold `tabIndex={0}`.
  // 0 = "All" pill (matches `selected === null`); otherwise the index of the
  // matching status + 1 (offset by the leading "All" pill).
  const activeIndex =
    selected === null ? 0 : Math.max(0, options.indexOf(selected) + 1);

  // Resolve a radio index back to its `selected` value. Index 0 = "All"
  // (null); 1..N = `options[index - 1]`.
  function valueAt(index: number): BridgeStatus | null {
    return index === 0 ? null : (options[index - 1] ?? null);
  }

  function focusAndSelect(
    container: HTMLElement,
    nextIndex: number,
    fallbackIndex: number,
  ) {
    const radios = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    if (radios.length === 0) return;
    const safeIndex =
      nextIndex >= 0 && nextIndex < radios.length ? nextIndex : fallbackIndex;
    radios[safeIndex]?.focus();
    const newValue = valueAt(safeIndex);
    if (newValue !== selected) onChange(newValue);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const key = e.key;
    if (
      key !== "ArrowDown" &&
      key !== "ArrowRight" &&
      key !== "ArrowUp" &&
      key !== "ArrowLeft" &&
      key !== "Home" &&
      key !== "End"
    ) {
      return;
    }
    e.preventDefault();
    const container = e.currentTarget;
    const radios = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    if (radios.length === 0) return;
    const currentIndex = radios.indexOf(e.target as HTMLButtonElement);
    // If the keydown originated outside the radio set (e.g. on the wrapper
    // itself), fall back to the currently selected pill.
    const fromIndex = currentIndex === -1 ? activeIndex : currentIndex;

    let nextIndex: number;
    if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = radios.length - 1;
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      nextIndex = (fromIndex + 1) % radios.length;
    } else {
      // ArrowUp / ArrowLeft
      nextIndex = (fromIndex - 1 + radios.length) % radios.length;
    }

    focusAndSelect(container, nextIndex, activeIndex);
  }

  return (
    // `tabIndex={-1}` keeps the wrapper out of the natural tab order
    // (the WAI-ARIA roving-tabindex pattern keeps focus on a single
    // child) while still satisfying `jsx-a11y/interactive-supports-focus`,
    // which insists an element with an interactive role be focusable.
    <div
      role="radiogroup"
      aria-label="Filter transfers by status"
      className="flex flex-wrap items-center gap-1.5"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <span className="text-xs text-slate-500 mr-1">Status:</span>
      <button
        type="button"
        role="radio"
        aria-checked={selected === null}
        tabIndex={activeIndex === 0 ? 0 : -1}
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
      {options.map((status, i) => {
        const active = selected === status;
        const radioIndex = i + 1;
        return (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={radioIndex === activeIndex ? 0 : -1}
            onClick={() => !active && onChange(status)}
            className={
              "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
              (active
                ? "bg-slate-700 text-slate-200"
                : "bg-slate-800/60 text-slate-400 hover:text-slate-200")
            }
          >
            {bridgeStatusDetailLabel(status)}
          </button>
        );
      })}
    </div>
  );
}
