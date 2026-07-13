import { DEFAULT_SWAPS_LIMIT } from "@/lib/constants";
import {
  PoolsTableSkeleton,
  SwapsTableSkeleton,
} from "./_components/pools-skeletons";

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

// This route loading UI runs during the server-side await in `page.tsx` and
// on client-side nav, before any URL state is readable, so it can't follow a
// non-default `?limit=` selection — it reserves `DEFAULT_SWAPS_LIMIT` (mirrors
// `pools-page-client.tsx`'s own fallback for the same URL param) instead.

// Route-shaped skeleton for /pools (SSR await in `page.tsx` + client-side
// nav to /pools). Mirrors `pools-page-client.tsx`'s `PoolsContent`: the
// 3-tile KPI row, the pools table section, and the Recent Swaps section —
// see `page.tsx` for why this route previously shipped with no loading
// boundary at all (a generic skeleton measured 0.4896 CLS) and why a
// shape-matched one is safe. A single live region wraps the presentational
// child skeletons.
export default function PoolsLoading() {
  return (
    <div
      className="space-y-8"
      role="status"
      aria-live="polite"
      aria-label="Loading"
    >
      {/* KPI row — mirrors the grid grid-cols-1 sm:grid-cols-3 gap-4 Pools /
          Showing / Latest Swap Block tiles. None of the three render a
          subtitle, so the placeholder omits one too — both land on the
          shared min-h-[88px] clamp. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`pools-kpi-${i}`}
            className="min-h-[88px] rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4"
          >
            <div className={`h-3 w-16 ${SHIMMER}`} />
            <div className={`mt-2 h-7 w-20 ${SHIMMER}`} />
          </div>
        ))}
      </div>

      {/* Pools table — mirrors the "Pools" section heading + GlobalPoolsTable.
          Sized via `PoolsTableSkeleton` (POOLS_TABLE_SKELETON_ROWS rows at
          the pools-table-measured 45px header / 58px row rhythm, not the
          shared TableSkeleton's 36/44 — see pools-skeletons.tsx). */}
      <section>
        <div className={`mb-3 h-6 w-16 ${SHIMMER}`} />
        <PoolsTableSkeleton />
      </section>

      {/* Recent Swaps section — mirrors the heading, filter/limit controls
          row, and SwapTable. Sized via `SwapsTableSkeleton` (45px header /
          37px rows — see pools-skeletons.tsx) so this route fallback lands
          at the same height as pools-page-client.tsx's own swaps skeleton
          and the real loaded SwapTable. */}
      <section>
        <div className={`mb-3 h-6 w-32 ${SHIMMER}`} />
        <div className={`mb-4 h-9 w-full max-w-2xl ${SHIMMER}`} />
        <SwapsTableSkeleton rows={DEFAULT_SWAPS_LIMIT} presentational />
      </section>

      <span className="sr-only">Loading…</span>
    </div>
  );
}
