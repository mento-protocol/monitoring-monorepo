/**
 * Shared search input for pool detail data tables.
 *
 * Mirrors the address-book search styling.  Each table tab renders its own
 * instance with a tab-specific placeholder.
 */

import { useEffect, useReducer, useRef } from "react";

type TableSearchProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  debounceMs?: number;
  /** Override the wrapper `<div>` classes. Defaults to the legacy
   *  `mb-4` block layout; panels that want the search inline with other
   *  filter controls can pass an empty string (or flex classes). */
  containerClassName?: string;
  /** Override the input's width classes. Defaults to `w-full max-w-sm`. */
  inputClassName?: string;
};

export function TableSearch({
  value,
  onChange,
  placeholder = "Search…",
  ariaLabel = "Search table",
  debounceMs = 150,
  containerClassName = "mb-4",
  inputClassName = "w-full max-w-sm",
}: TableSearchProps) {
  const [draft, dispatchDraft] = useReducer(
    (_: string, nextValue: string) => nextValue,
    value,
  );
  const timeoutRef = useRef<number | null>(null);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (value === lastCommittedValueRef.current) return;
    lastCommittedValueRef.current = value;
    dispatchDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  return (
    <div className={containerClassName}>
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
            timeoutRef.current = null;
            lastCommittedValueRef.current = nextValue;
            onChange(nextValue);
          }, debounceMs);
        }}
        aria-label={ariaLabel}
        className={`${inputClassName} rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500`}
      />
    </div>
  );
}
