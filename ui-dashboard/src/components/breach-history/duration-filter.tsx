"use client";

/**
 * Duration-range filter inputs for the BreachHistoryPanel. Extracted from
 * breach-history-panel.tsx. Contains `DurationField` (a single controlled
 * text input that parses human-readable durations like "1h 30m" and commits
 * them as numeric seconds on blur or Enter) and `DurationRangeInputs` (a
 * min/max pair of DurationFields). Neither component owns state beyond the
 * local draft text; committed values are lifted to the parent via `onCommit`
 * / `onMinCommit` / `onMaxCommit`.
 */

import { useCallback, useState } from "react";
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
        id="breach-duration-min"
        ariaLabel="Minimum breach duration"
        placeholder="Min."
        committedSeconds={minSeconds}
        onCommit={onMinCommit}
      />
      <span className="text-xs text-slate-600">–</span>
      <DurationField
        id="breach-duration-max"
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

const DURATION_FORMAT_HINT_ID = "breach-duration-format-hint";
const DURATION_FORMAT_HINT = "Accepts: 1h, 30m, 3d, 1h 30m, 2 hours, etc.";

/**
 * Single duration input. Keeps its own draft text so the parent only
 * re-renders (and re-fires the GraphQL query) on blur or Enter. An empty
 * draft commits `null` — clears the filter instead of leaving it stale.
 * A parse failure keeps the previous committed value and flags the input
 * with a red ring until the user fixes it.
 *
 * Format guidance is rendered as a visible hint below the inputs and
 * referenced via `aria-describedby` so it's always accessible — not only
 * on hover.
 */
function DurationField({
  id,
  ariaLabel,
  placeholder,
  committedSeconds,
  onCommit,
}: {
  id: string;
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
      id={id}
      type="text"
      inputMode="text"
      autoComplete="off"
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={DURATION_FORMAT_HINT_ID}
      aria-invalid={invalid || undefined}
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
    />
  );
}

/**
 * Visible + screen-reader-accessible format hint shared by both duration
 * fields. Rendered once below the min/max pair; referenced via
 * `aria-describedby` on each input.
 */
export function DurationFormatHint() {
  return (
    <p id={DURATION_FORMAT_HINT_ID} className="text-[10px] text-slate-500">
      {DURATION_FORMAT_HINT}
    </p>
  );
}
