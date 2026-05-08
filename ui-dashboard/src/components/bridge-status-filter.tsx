"use client";

import { useRef, useState } from "react";
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
 * Implements the WAI-ARIA radiogroup keyboard contract
 * (https://www.w3.org/WAI/ARIA/apg/patterns/radio/ — selection follows
 * focus per the spec):
 * - Single tab stop: `tabIndex={0}` on the selected pill, `tabIndex={-1}`
 *   on all others.
 * - Arrow keys (Left/Right/Up/Down) move focus AND change selection.
 * - Home / End jump to first / last option (and select it).
 * - Space/Enter activate the focused pill (native `<button>` behavior).
 *
 * NOTE on URL-backed callers: the keyboard handler always calls
 * `onChange` (no equality guard against `selected`). Some callers wire
 * `onChange` to a `router.replace` URL update; the `selected` prop
 * therefore lags one render cycle behind keyboard activity. Comparing
 * the new value against the stale prop and skipping `onChange` would
 * race: a quick End-then-Home before the URL re-render would compute
 * `newValue === null === selected` and silently skip, leaving focus on
 * the first pill while the pending End navigation commits the last
 * status. Always firing `onChange` accepts an extra no-op
 * `router.replace` per same-pill keystroke (cheap; same-URL replace
 * deduped by Next).
 *
 * Pill index map: 0 = "All" (`null`), 1..N = `options[i - 1]`.
 */
export function BridgeStatusFilter({
  options,
  selected,
  onChange,
}: BridgeStatusFilterProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  // Index in the radio sequence (0 = "All" pill, 1..N = `options[i - 1]`).
  const activeIndex =
    selected === null ? 0 : Math.max(0, options.indexOf(selected) + 1);
  // Roving tabindex: `tabIndex={0}` follows the FOCUSED radio, not
  // the selected one. Tying the tab stop to `selected` was racy on
  // URL-backed callers — between an arrow keystroke and the
  // router.replace re-render, focus had already moved but the prop
  // (and therefore tabIndex) hadn't, leaving the user able to Tab
  // back to the stale tab stop instead of leaving the group (codex
  // finding on PR #350). The local `focusedIndex` updates
  // synchronously via the radios' `onFocus`.
  const [focusedIndex, setFocusedIndex] = useState(activeIndex);
  // Re-sync to `activeIndex` on external prop changes (e.g. browser
  // back-button mutating the URL) when focus is NOT in the group.
  // Detected during render via a ref; `setState` during render is
  // React-allowed for derived-from-prop sync and avoids the
  // `no-direct-set-state-in-use-effect` lint.
  const lastActiveIndexRef = useRef(activeIndex);
  if (lastActiveIndexRef.current !== activeIndex) {
    lastActiveIndexRef.current = activeIndex;
    if (!groupRef.current?.contains(document.activeElement)) {
      setFocusedIndex(activeIndex);
    }
  }

  // Resolve a radio index back to its `selected` value. Index 0 = "All"
  // (null); 1..N = `options[index - 1]`.
  function valueAt(index: number): BridgeStatus | null {
    return index === 0 ? null : (options[index - 1] ?? null);
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
    const radios = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    if (radios.length === 0) return;
    const currentIndex = radios.indexOf(e.target as HTMLButtonElement);
    // If the keydown originated outside the radio set (e.g. on the wrapper
    // itself), fall back to the currently focused pill.
    const fromIndex = currentIndex === -1 ? focusedIndex : currentIndex;

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

    radios[nextIndex]?.focus();
    onChange(valueAt(nextIndex));
  }

  return (
    // `tabIndex={-1}` keeps the wrapper out of the natural tab order
    // (the WAI-ARIA roving-tabindex pattern keeps focus on a single
    // child) while still satisfying `jsx-a11y/interactive-supports-focus`,
    // which insists an element with an interactive role be focusable.
    <div
      ref={groupRef}
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
        tabIndex={focusedIndex === 0 ? 0 : -1}
        onFocus={() => setFocusedIndex(0)}
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
            tabIndex={radioIndex === focusedIndex ? 0 : -1}
            onFocus={() => setFocusedIndex(radioIndex)}
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
