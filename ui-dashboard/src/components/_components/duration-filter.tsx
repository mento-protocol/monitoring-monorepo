"use client";

/**
 * Duration-range filter inputs for the BreachHistoryPanel. Extracted from
 * breach-history-panel.tsx (PR-A5). Contains `DurationField` (a single
 * controlled text input that parses human-readable durations like "1h 30m"
 * and commits them as numeric seconds on blur or Enter) and
 * `DurationRangeInputs` (a min/max pair of DurationFields). Neither
 * component owns state beyond the local draft text; committed values are
 * lifted to the parent via `onCommit` / `onMinCommit` / `onMaxCommit`.
 */

import React, { useCallback, useState } from "react";
import { formatDurationShort, parseDurationSeconds } from "@/lib/bridge-status";

// ---------------------------------------------------------------------------
// DurationRangeInputs
// ---------------------------------------------------------------------------

export function DurationRangeInputs({
  minSeconds,
  maxSeconds,
  onMinCommit,
  onMaxCommit,
}: {
  minSeconds: number | null;
  maxSeconds: number | null;
  onMinCommit: (seconds: number | null) => void;
  onMaxCommit: (seconds: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <DurationField
        ariaLabel="Minimum breach duration"
        placeholder="Min."
        committedSeconds={minSeconds}
        onCommit={onMinCommit}
      />
      <span className="text-xs text-slate-600">–</span>
      <DurationField
        ariaLabel="Maximum breach duration"
        placeholder="Max."
        committedSeconds={maxSeconds}
        onCommit={onMaxCommit}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DurationField
// ---------------------------------------------------------------------------

/**
 * Single duration input. Keeps its own draft text so the parent only
 * re-renders (and re-fires the GraphQL query) on blur or Enter. An empty
 * draft commits `null` — clears the filter instead of leaving it stale.
 * A parse failure keeps the previous committed value and flags the input
 * with a red ring until the user fixes it.
 */
export function DurationField({
  ariaLabel,
  placeholder,
  committedSeconds,
  onCommit,
}: {
  ariaLabel: string;
  placeholder: string;
  committedSeconds: number | null;
  onCommit: (seconds: number | null) => void;
}) {
  const [draft, setDraft] = useState(() =>
    committedSeconds != null ? formatDurationShort(committedSeconds) : "",
  );
  const [invalid, setInvalid] = useState(false);
  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setInvalid(false);
      onCommit(null);
      return;
    }
    const parsed = parseDurationSeconds(trimmed);
    if (parsed == null || parsed <= 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit(parsed);
  }, [draft, onCommit]);
  return (
    <input
      type="text"
      inputMode="text"
      autoComplete="off"
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        // Clear the error as soon as they start fixing it — no point
        // yelling while they type.
        if (invalid) setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      className={
        "w-20 rounded-lg border bg-slate-800 px-2 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 " +
        (invalid
          ? "border-red-500/70 focus:border-red-400 focus:ring-red-400"
          : "border-slate-700 focus:border-indigo-500 focus:ring-indigo-500")
      }
      title={
        invalid
          ? 'Enter a duration like "1h", "30m", "3 days"'
          : "Filter by duration. Supports 1h, 30m, 3d, 1h30m, 2 hours…"
      }
    />
  );
}
