"use client";

import { LimitSelect } from "@/components/controls";
import { useRovingTabIndex } from "@/lib/use-roving-tab-index";
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
 *  - Single tab stop: `tabIndex={0}` starts on the selected tab, then
 *    follows local focus; all other tabs are `tabIndex={-1}`.
 *  - Left / Right / Home / End move focus only. Activation does NOT
 *    follow focus.
 *  - Space / Enter (or click) on the focused tab activates it via the
 *    native `<button>`'s `onClick` → `onSelect`.
 *
 *  Manual activation (vs. automatic) because tab activation still changes
 *  URL state and fetches tab-specific data. Automatic activation would fire
 *  that work per arrow keystroke — a held arrow key turns into a query storm,
 *  plus a stale-prop race (the URL-backed `active` prop hasn't updated by
 *  the time the next arrow fires) that can desync focus from URL state.
 *  Codex flagged both on PR #350.
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
  const activeIndex = Math.max(0, visibleTabs.indexOf(active));
  const {
    groupRef: tablistRef,
    getItemProps,
    handleKeyDown,
  } = useRovingTabIndex({
    activeIndex,
    itemCount: visibleTabs.length,
    activation: "manual",
    arrowKeys: "horizontal",
  });

  return (
    // The `role="tablist"` element MUST only contain `role="tab"`
    // children (axe rule `aria-required-children`). The LimitSelect
    // is rendered alongside the tablist as a sibling inside the
    // shared flex row, NOT inside the tablist itself. Folding the
    // select into the tablist (as the previous markup did) is a
    // critical a11y violation.
    <div className="flex w-full min-w-0 gap-1 overflow-x-auto border-b border-slate-800">
      <div
        ref={tablistRef}
        className="flex min-w-max gap-1"
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
        {visibleTabs.map((t, i) => {
          const rovingProps = getItemProps(i);
          return (
            <button
              key={t}
              ref={rovingProps.ref}
              role="tab"
              id={`tab-${t}`}
              aria-selected={active === t}
              aria-controls={`panel-${t}`}
              tabIndex={rovingProps.tabIndex}
              onFocus={rovingProps.onFocus}
              onClick={() => onSelect(t)}
              className={`px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium capitalize transition-colors ${
                active === t
                  ? "border-b-2 border-indigo-500 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {getTabLabel(t)}
            </button>
          );
        })}
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
