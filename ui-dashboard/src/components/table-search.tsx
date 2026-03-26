/**
 * Shared search input for pool detail data tables.
 *
 * Mirrors the address-book search styling.  Each table tab renders its own
 * instance with a tab-specific placeholder.
 */

import { useEffect, useState } from "react";

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
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (draft === value) return;
    const timeoutId = window.setTimeout(() => {
      onChange(draft);
    }, debounceMs);
    return () => window.clearTimeout(timeoutId);
  }, [draft, value, onChange, debounceMs]);

  return (
    <div className="mb-4">
      <input
        type="search"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={ariaLabel}
        className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
    </div>
  );
}
