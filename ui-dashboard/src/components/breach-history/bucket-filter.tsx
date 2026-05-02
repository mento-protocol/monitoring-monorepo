"use client";

/**
 * BucketFilter sub-component for the BreachHistoryPanel. Renders a
 * radiogroup of five duration presets (All, ≤1h, 1h–1d, Over 1d, Ongoing).
 * `whereForBucket` / `composeWhere` helpers live in `./filters.ts` alongside
 * BreachTable and BreachRow; they reference `SECONDS_PER_HOUR` /
 * `SECONDS_PER_DAY` from `@/lib/time-series` to share constants with the
 * rest of the codebase.
 *
 * Implements the WAI-ARIA radio button keyboard contract: arrow keys move
 * focus + selection between options; Tab leaves the group.
 */

import type React from "react";

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

/** Static options array — hoisted to module scope to avoid per-render allocation. */
const BUCKET_OPTIONS: DurationBucket[] = [
  "all",
  "in_grace",
  "short",
  "long",
  "ongoing",
];

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
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowRight" &&
      e.key !== "ArrowUp" &&
      e.key !== "ArrowLeft"
    )
      return;
    e.preventDefault();
    const radios = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    const idx = radios.indexOf(e.target as HTMLButtonElement);
    if (idx === -1) return;
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (idx + 1) % radios.length
        : (idx - 1 + radios.length) % radios.length;
    radios[next].focus();
    const newBucket = BUCKET_OPTIONS[next];
    if (newBucket !== selected) onChange(newBucket);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Filter breaches by duration"
      className="flex flex-wrap gap-1.5"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {BUCKET_OPTIONS.map((b) => {
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
