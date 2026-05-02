"use client";

/**
 * BucketFilter sub-component for the BreachHistoryPanel. Renders a
 * radiogroup of five duration presets (All, ≤1h, 1h–1d, Over 1d, Ongoing).
 * The parent's `whereForBucket` / `composeWhere` helpers (still in the
 * panel; move in PR-A6) reference `SECONDS_PER_HOUR` / `SECONDS_PER_DAY`
 * directly from `@/lib/time-series` to share constants with the rest of
 * the codebase.
 */

import React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Duration-range filter presets. Each one compiles to a Hasura
 * `_and`-able where clause. Buckets line up with how operators think
 * about breach severity (in-grace = WARN-only, 1h–1d = moderately bad,
 * >1d = really stuck).
 */
export type DurationBucket = "all" | "in_grace" | "short" | "long" | "ongoing";

export const BUCKET_LABEL: Record<DurationBucket, string> = {
  all: "All",
  in_grace: "≤1h",
  short: "1h – 1d",
  long: "Over 1d",
  ongoing: "Ongoing",
};

// ---------------------------------------------------------------------------
// BucketFilter
// ---------------------------------------------------------------------------

export function BucketFilter({
  selected,
  onChange,
}: {
  selected: DurationBucket;
  onChange: (next: DurationBucket) => void;
}) {
  const options: DurationBucket[] = [
    "all",
    "in_grace",
    "short",
    "long",
    "ongoing",
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Filter breaches by duration"
      className="flex flex-wrap gap-1.5"
    >
      {options.map((b) => {
        const active = b === selected;
        return (
          <button
            key={b}
            role="radio"
            type="button"
            aria-checked={active}
            onClick={() => !active && onChange(b)}
            className={
              "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
              (active
                ? "bg-slate-700 text-slate-200"
                : "bg-slate-800/60 text-slate-400 hover:text-slate-200")
            }
          >
            {BUCKET_LABEL[b]}
          </button>
        );
      })}
    </div>
  );
}
