import type { ReactNode } from "react";

/**
 * Shared chrome + loading skeletons for the flow-insight panels.
 *
 * Lives in its own module (rather than inside `v3-flow-insight-panels.tsx`)
 * so the Server Component route fallback (`../loading.tsx`) can render the
 * exact same loading composition the client's `V3FlowInsights` panels
 * render, without dragging the loaded-panel dependencies (`AddressLink`,
 * `ChainIcon`, token/network libs) into the fallback's server bundle —
 * same split rationale as `../_lib/skeleton-rows.ts`. Sharing the
 * components (instead of hand-mirroring measured heights in the fallback)
 * keeps the fallback→client handoff structurally identical at every
 * breakpoint, including below `xl` where the panel grid stacks and each
 * panel reserves its real intrinsic height (codex review, PR 1242).
 *
 * The skeletons announce themselves (`role="status"`) by default — the
 * client renders them standalone. The route fallback passes
 * `presentational` because its root already wraps the whole page in a
 * single polite live region (same convention as `TableSkeleton` in
 * `@/components/skeletons`).
 */

type InsightSkeletonAriaProps = {
  presentational?: boolean | undefined;
};

function statusRegion(
  label: string,
  presentational: boolean | undefined,
): Record<string, string> {
  if (presentational) return {};
  return { role: "status", "aria-label": label };
}

export function InsightPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

// Mirrors CohortPanel's loaded shape (3-stat mini grid + 3 leader rows +
// caption line) so the section doesn't grow when the query resolves — the
// old `<Skeleton rows={4} />` (4 generic 40px bars) undershot the real
// content by roughly half.
export function CohortPanelSkeleton({
  presentational,
}: InsightSkeletonAriaProps) {
  return (
    <div
      className="space-y-4"
      {...statusRegion("Loading cohort comparison", presentational)}
    >
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`cohort-skel-stat-${i}`} className="min-w-0">
            <div className="h-[11px] w-10 animate-pulse rounded bg-slate-800/50" />
            <div className="mt-1 h-[18px] w-8 animate-pulse rounded bg-slate-800/50" />
          </div>
        ))}
      </div>
      <div className="space-y-2 text-xs">
        {Array.from({ length: 3 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`cohort-skel-leader-${i}`}
            className="flex items-center justify-between gap-3"
          >
            <div className="h-3 w-16 animate-pulse rounded bg-slate-800/40" />
            <div className="h-3 w-28 animate-pulse rounded bg-slate-800/40" />
          </div>
        ))}
      </div>
      <div className="h-[11px] w-40 animate-pulse rounded bg-slate-800/40" />
      {!presentational && <span className="sr-only">Loading…</span>}
    </div>
  );
}

// Corridor/outlier queries cap at 10 rows (`INSIGHT_ROW_LIMIT` in
// `v3-flow-insights.tsx`), and that cap is the common case in production —
// both tables are usually query-capped (`isPartial`), which also renders a
// trailing "Top-query subset…" caption below the table. `INSIGHT_PANEL_SKELETON_ROWS`
// mirrors the cap so the skeleton doesn't undershoot the loaded table on the
// (common) capped path. The row rhythm (`py-3` + `h-3`, 36px) matches the
// measured real row height (~36-37px) so an uncapped result (fewer than 10
// rows, no trailing warning line) doesn't overshoot the loaded panel either —
// real rows are denser than the shared `TableSkeleton`'s 36px/44px
// main-table geometry, so this stays a local skeleton rather than reusing
// that primitive.
//
// A live measurement (2026-07-13, 1440x900, production build/data) with the
// row rhythm above already in place still showed the flow-insights section
// growing 496px -> 542px (+46px) between the SWR-loading and loaded phases,
// isolating the remaining gap to that trailing caption paragraph
// (`pt-2 text-[11px]`), which this skeleton didn't reserve at all. Its
// column (~421px wide inside the xl:grid-cols-3 layout, minus the panel's
// p-4 padding) is narrow relative to the longer outlier caption text
// ("Top-query subset; eligible outliers beyond the fetch cap may be
// absent.", ~68 chars), so it can wrap to 2 lines. The reserved placeholder
// below always renders 2 lines (`mt-2` + 2x `h-3` + `space-y-1` =
// 8 + 12 + 4 + 12 = 36px): 496 + 36 = 532, a 10px gap against the measured
// 542px loaded height (within the ±24px parity bar), with margin on both
// sides for measurement noise.
const INSIGHT_PANEL_SKELETON_ROWS = 10;

export function InsightTableSkeleton({
  cols,
  label,
  presentational,
}: {
  cols: number;
  label: string;
} & InsightSkeletonAriaProps) {
  return (
    <div {...statusRegion(label, presentational)}>
      <div className="flex gap-3 border-b border-slate-800 py-2.5">
        {Array.from({ length: cols }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`insight-skel-th-${i}`}
            className="h-3 flex-1 animate-pulse rounded bg-slate-800/50"
          />
        ))}
      </div>
      <div className="divide-y divide-slate-800/40">
        {Array.from({ length: INSIGHT_PANEL_SKELETON_ROWS }, (_, rowIdx) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`insight-skel-row-${rowIdx}`} className="flex gap-3 py-3">
            {Array.from({ length: cols }, (_, colIdx) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-as-key
              <div
                key={`insight-skel-cell-${rowIdx}-${colIdx}`}
                className="h-3 flex-1 animate-pulse rounded bg-slate-800/40"
              />
            ))}
          </div>
        ))}
      </div>
      {/* Reserves the trailing "Top-query subset…" caption both panels
          render when isPartial && rows.length > 0 — the common capped case
          (see INSIGHT_PANEL_SKELETON_ROWS above), reserved unconditionally
          since this skeleton has no isPartial input of its own. */}
      <div className="mt-2 space-y-1">
        <div className="h-3 w-full animate-pulse rounded bg-slate-800/40" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-slate-800/40" />
      </div>
      {!presentational && <span className="sr-only">Loading…</span>}
    </div>
  );
}
