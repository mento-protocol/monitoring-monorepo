"use client";

import { bridgeStatusDetailLabel } from "@/lib/bridge-status";
import type { BridgeStatus } from "@/lib/types";
import { useRovingTabIndex } from "@/lib/use-roving-tab-index";

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
 * - Single tab stop: `tabIndex={0}` starts on the selected pill, then
 *   follows local focus; all other radios are `tabIndex={-1}`.
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
  // Index in the radio sequence (0 = "All" pill, 1..N = `options[i - 1]`).
  const activeIndex =
    selected === null ? 0 : Math.max(0, options.indexOf(selected) + 1);

  // Resolve a radio index back to its `selected` value. Index 0 = "All"
  // (null); 1..N = `options[index - 1]`.
  function valueAt(index: number): BridgeStatus | null {
    return index === 0 ? null : (options[index - 1] ?? null);
  }

  const { groupRef, getItemProps, handleKeyDown } = useRovingTabIndex({
    activeIndex,
    itemCount: options.length + 1,
    activation: "automatic",
    arrowKeys: "all",
    onActivate: (index) => onChange(valueAt(index)),
  });
  const allRovingProps = getItemProps(0);

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
        ref={allRovingProps.ref}
        tabIndex={allRovingProps.tabIndex}
        onFocus={allRovingProps.onFocus}
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
        const rovingProps = getItemProps(radioIndex);
        return (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={active}
            ref={rovingProps.ref}
            tabIndex={rovingProps.tabIndex}
            onFocus={rovingProps.onFocus}
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
