/**
 * Shared search input for pool detail data tables.
 *
 * Mirrors the address-book search styling.  Each table tab renders its own
 * instance with a tab-specific placeholder.
 */

import { useEffect, useRef } from "react";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || input.value === value) return;
    input.value = value;
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
    <div className="mb-4">
      <input
        ref={inputRef}
        type="search"
        placeholder={placeholder}
        defaultValue={value}
        onChange={(e) => {
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
          }
          const nextValue = e.target.value;
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
