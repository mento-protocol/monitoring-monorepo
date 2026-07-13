import { TableSkeleton, TileGridSkeleton } from "@/components/skeletons";
import { ROW_CHART_HEIGHT_PX } from "@/lib/plot";

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Homepage-shaped route loading UI (SSR await in `page.tsx` + client-side
// nav to `/`). Mirrors `page-client.tsx`'s `GlobalContent`: header, two
// chart cards, a 4-tile KPI row, and the "All Pools" table, so the swap from
// skeleton to real content reads as fill-in rather than a full repaint.
// `/pools` uses its own `pools/loading.tsx`; this remains the nearest
// boundary for every other route that doesn't suspend on its own.

// Mirrors TimeSeriesChartCard's card chrome (p-5 sm:p-6, title line,
// 3xl/4xl headline, delta row, ROW_CHART_HEIGHT_PX plot) — same pattern as
// `pool/[poolId]/loading.tsx`'s `ChartCardSkeleton`. Both homepage cards
// (TVL, Volume) omit `reserveDeltaRow`, so both default to `true` and
// always reserve the delta row here too.
function ChartCardSkeleton() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className={`h-5 w-28 ${SHIMMER}`} />
      <div className={`mt-1 h-10 w-36 ${SHIMMER}`} />
      <div className={`mt-1 h-5 w-32 ${SHIMMER}`} />
      <div
        className="mt-4 animate-pulse rounded bg-slate-800/30"
        style={{ height: ROW_CHART_HEIGHT_PX }}
      />
    </div>
  );
}

export default function RootLoading() {
  return (
    <div
      className="space-y-8"
      role="status"
      aria-live="polite"
      aria-label="Loading"
    >
      {/* Header — mirrors GlobalContent's h1 + subtitle. */}
      <div>
        <div className={`h-8 w-56 ${SHIMMER}`} />
        <div className={`mt-1 h-4 w-72 ${SHIMMER}`} />
      </div>

      {/* Charts row — mirrors the grid grid-cols-1 lg:grid-cols-2 gap-6
          TVL + Volume TimeSeriesChartCards, absent from the prior generic
          skeleton entirely. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCardSkeleton />
        <ChartCardSkeleton />
      </div>

      {/* KPI row — mirrors the grid grid-cols-2 lg:grid-cols-4 gap-4 row of
          Swap Fees / LPs / Swaps / Traders tiles. */}
      <section>
        <TileGridSkeleton count={4} presentational />
      </section>

      {/* Pools table — mirrors the "All Pools" section. A fixed 10-row
          placeholder can't match the real ~30-50 pool table exactly, but it
          replaces the prior 8-col generic table with the real row rhythm
          (header ~36px, rows ~44px) so the swap-in reads as fill rather
          than repaint. */}
      <section>
        <div className={`mb-3 h-6 w-24 ${SHIMMER}`} />
        <TableSkeleton rows={10} variant="rows" presentational />
      </section>

      <span className="sr-only">Loading…</span>
    </div>
  );
}
