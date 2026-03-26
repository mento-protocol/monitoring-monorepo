/**
 * Shared search input for pool detail data tables.
 *
 * Mirrors the address-book search styling.  Each table tab renders its own
 * instance with a tab-specific placeholder.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

type TableSearchProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  debounceMs?: number;
};

export function TableSearch({
  value,
  onChange,
  placeholder = "Search…",
  ariaLabel = "Search table",
  debounceMs = 150,
}: TableSearchProps) {
  const [draft, dispatchDraft] = useReducer(
    (_: string, nextValue: string) => nextValue,
    value,
  );
  const timeoutRef = useRef<number | null>(null);
  const syncFromValue = useCallback((nextValue: string) => {
    dispatchDraft(nextValue);
  }, []);

  useEffect(() => {
    if (draft === value) return;
    syncFromValue(value);
  }, [value, draft, syncFromValue]);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  return (
    <div className="mb-4">
      <input
        type="search"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          const nextValue = e.target.value;
          dispatchDraft(nextValue);
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
          }
          timeoutRef.current = window.setTimeout(() => {
            onChange(nextValue);
          }, debounceMs);
        }}
        aria-label={ariaLabel}
        className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
    </div>
  );
}
