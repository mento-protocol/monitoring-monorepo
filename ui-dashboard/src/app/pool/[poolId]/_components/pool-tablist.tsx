"use client";

import { LimitSelect } from "@/components/controls";
import { TABS_WITHOUT_LIMIT_SELECT, type Tab } from "../_lib/constants";
import { getTabLabel } from "../_lib/helpers";

/** Pool-page tablist + the inline LimitSelect that tags along with the
 *  paginated tabs. Extracted so the a11y tests can mount the production
 *  markup verbatim — previously the test re-implemented this JSX, which
 *  meant a regression on `role="tablist"` / `aria-controls` / button
 *  ordering would slip past the test silently (Cursor finding on PR #342).
 *
 *  Implements the WAI-ARIA tablist keyboard contract (automatic
 *  activation):
 *  - Single tab stop: `tabIndex={0}` on the selected tab,
 *    `tabIndex={-1}` on all others.
 *  - Left / Right arrows move focus AND activate the tab (`onSelect`
 *    called as focus moves).
 *  - Home / End jump to first / last and activate.
 *  - Space / Enter activate the focused tab (native `<button>`).
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
  // The selected tab is the single tab stop. Resolve its index in the
  // visible list so we can fall back to it when keydown originates outside
  // the tab buttons (defensive — shouldn't happen via Tab focus).
  const activeIndex = Math.max(0, visibleTabs.indexOf(active));

  function focusAndActivate(container: HTMLElement, nextIndex: number) {
    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    if (tabs.length === 0) return;
    const safeIndex =
      nextIndex >= 0 && nextIndex < tabs.length ? nextIndex : activeIndex;
    tabs[safeIndex]?.focus();
    const nextTab = visibleTabs[safeIndex];
    if (nextTab !== undefined && nextTab !== active) onSelect(nextTab);
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
    const container = e.currentTarget;
    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    if (tabs.length === 0) return;
    const currentIndex = tabs.indexOf(e.target as HTMLButtonElement);
    const fromIndex = currentIndex === -1 ? activeIndex : currentIndex;

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

    focusAndActivate(container, nextIndex);
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
        className="flex gap-1"
        role="tablist"
        aria-label="Pool data tabs"
        onKeyDown={handleKeyDown}
        // `tabIndex={-1}` keeps the wrapper out of the natural tab
        // order (the WAI-ARIA roving-tabindex pattern keeps focus on
        // the selected `role="tab"` child) while satisfying
        // `jsx-a11y/interactive-supports-focus`, which requires an
        // element with an interactive role be focusable.
        tabIndex={-1}
      >
        {visibleTabs.map((t) => (
          <button
            key={t}
            role="tab"
            id={`tab-${t}`}
            aria-selected={active === t}
            aria-controls={`panel-${t}`}
            tabIndex={active === t ? 0 : -1}
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
