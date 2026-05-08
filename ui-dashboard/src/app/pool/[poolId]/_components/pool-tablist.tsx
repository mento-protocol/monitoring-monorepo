"use client";

import { useRef, useState } from "react";
import { LimitSelect } from "@/components/controls";
import { TABS_WITHOUT_LIMIT_SELECT, type Tab } from "../_lib/constants";
import { getTabLabel } from "../_lib/helpers";

/** Pool-page tablist + the inline LimitSelect that tags along with the
 *  paginated tabs. Extracted so the a11y tests can mount the production
 *  markup verbatim — previously the test re-implemented this JSX, which
 *  meant a regression on `role="tablist"` / `aria-controls` / button
 *  ordering would slip past the test silently (Cursor finding on PR #342).
 *
 *  Implements the WAI-ARIA tablist keyboard contract with **manual
 *  activation** (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/ —
 *  manual activation is the spec-supported variant for tablists where
 *  activation is expensive):
 *  - Single tab stop: `tabIndex={0}` on the selected tab,
 *    `tabIndex={-1}` on all others.
 *  - Left / Right / Home / End move focus only. Activation does NOT
 *    follow focus.
 *  - Space / Enter (or click) on the focused tab activates it via the
 *    native `<button>`'s `onClick` → `onSelect`.
 *
 *  Manual activation (vs. automatic) because the pool page wires
 *  `onSelect` to a `router.replace` URL change, which triggers a Next
 *  App Router RSC refetch. Automatic activation would fire that
 *  navigation per arrow keystroke — a held arrow key turns into a
 *  navigation storm, plus a stale-prop race (the URL-backed `active`
 *  prop hasn't updated by the time the next arrow fires) that can
 *  desync focus from the URL state. Codex flagged both on PR #350.
 *
 *  `visibleTabs` is the page-side filtered list (e.g. `breaches` is
 *  hidden for virtual pools, `ols` only shows when the pool has an OLS
 *  vault). The component renders whatever the page supplies. */
export function PoolTablist({
  visibleTabs,
  active,
  onSelect,
  limit,
  onLimitChange,
}: {
  visibleTabs: ReadonlyArray<Tab>;
  active: Tab;
  onSelect: (tab: Tab) => void;
  /** Current page-size for paginated tabs. Drives the tag-along
   *  `LimitSelect` to its right (hidden when the active tab manages
   *  its own pagination — see `TABS_WITHOUT_LIMIT_SELECT`). */
  limit: number;
  onLimitChange: (limit: number) => void;
}) {
  const tablistRef = useRef<HTMLDivElement>(null);
  const activeIndex = Math.max(0, visibleTabs.indexOf(active));
  // Roving tabindex: `tabIndex={0}` follows the FOCUSED tab, not the
  // selected one. Initialised from `active`. With manual activation,
  // focus can intentionally diverge from selection (user arrows to a
  // tab without committing); leaving `tabIndex={0}` on the selected
  // tab in that state would re-trap Tab back to the selected tab
  // instead of letting it leave the group (codex finding on PR #350).
  const [focusedIndex, setFocusedIndex] = useState(activeIndex);
  // Re-sync `focusedIndex` to `active` when the prop changes externally
  // (e.g. browser back-button mutating the URL) and focus is NOT
  // currently in the tablist. When focus IS inside, the user owns the
  // roving position — leave it alone. Detected during render via a
  // ref of the last-seen `activeIndex`, then `setFocusedIndex` schedules
  // a re-render. React allows `setState` during render for
  // derived-from-prop sync; this avoids the
  // `no-direct-set-state-in-use-effect` lint and the extra effect tick.
  const lastActiveIndexRef = useRef(activeIndex);
  if (lastActiveIndexRef.current !== activeIndex) {
    lastActiveIndexRef.current = activeIndex;
    if (!tablistRef.current?.contains(document.activeElement)) {
      setFocusedIndex(activeIndex);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const key = e.key;
    if (
      key !== "ArrowLeft" &&
      key !== "ArrowRight" &&
      key !== "Home" &&
      key !== "End"
    ) {
      return;
    }
    e.preventDefault();
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    if (tabs.length === 0) return;
    const currentIndex = tabs.indexOf(e.target as HTMLButtonElement);
    const fromIndex = currentIndex === -1 ? focusedIndex : currentIndex;

    let nextIndex: number;
    if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = tabs.length - 1;
    } else if (key === "ArrowRight") {
      nextIndex = (fromIndex + 1) % tabs.length;
    } else {
      // ArrowLeft
      nextIndex = (fromIndex - 1 + tabs.length) % tabs.length;
    }

    // Manual activation: move focus only, do NOT call `onSelect` here.
    // Activation happens on Space/Enter (native button onClick) or click.
    // The focused tab's `onFocus` updates `focusedIndex` synchronously.
    tabs[nextIndex]?.focus();
  }

  return (
    // The `role="tablist"` element MUST only contain `role="tab"`
    // children (axe rule `aria-required-children`). The LimitSelect
    // is rendered alongside the tablist as a sibling inside the
    // shared flex row, NOT inside the tablist itself. Folding the
    // select into the tablist (as the previous markup did) is a
    // critical a11y violation.
    <div className="flex gap-1 border-b border-slate-800">
      <div
        ref={tablistRef}
        className="flex gap-1"
        role="tablist"
        aria-label="Pool data tabs"
        onKeyDown={handleKeyDown}
        // `tabIndex={-1}` keeps the wrapper out of the natural tab
        // order (the WAI-ARIA roving-tabindex pattern keeps focus on
        // a single `role="tab"` child) while satisfying
        // `jsx-a11y/interactive-supports-focus`, which requires an
        // element with an interactive role be focusable.
        tabIndex={-1}
      >
        {visibleTabs.map((t, i) => (
          <button
            key={t}
            role="tab"
            id={`tab-${t}`}
            aria-selected={active === t}
            aria-controls={`panel-${t}`}
            tabIndex={i === focusedIndex ? 0 : -1}
            onFocus={() => setFocusedIndex(i)}
            onClick={() => onSelect(t)}
            className={`px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium capitalize transition-colors ${
              active === t
                ? "border-b-2 border-indigo-500 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {getTabLabel(t)}
          </button>
        ))}
      </div>
      {/* Oracle tab manages its own page size; Limits has no paginated data */}
      {!TABS_WITHOUT_LIMIT_SELECT.has(active) && (
        <div className="ml-auto hidden sm:flex items-center">
          <LimitSelect id="tab-limit" value={limit} onChange={onLimitChange} />
        </div>
      )}
    </div>
  );
}
