import { TableSkeleton } from "@/components/skeletons";

// Matches the real pool detail layout: breadcrumb + header card + health bar
// + charts row + 7 tabs (see TABS in page.tsx) + a 6-column default table.
// The header/health/charts placeholders mirror the geometry of PoolHeader,
// HealthPanel, and PoolChartsRow (pool-detail-page-client.tsx) so the tab
// strip and table don't jump down when the real page streams in (CLS).
// ARIA announcement lives on TableSkeleton itself so we don't nest live
// regions.

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Mirrors TimeSeriesChartCard: p-5 sm:p-6 card, text-sm title, 3xl/4xl mono
// headline, h-5 change row, then a plot area at ROW_CHART_HEIGHT_PX (200).
function ChartCardSkeleton() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className={`h-5 w-28 ${SHIMMER}`} />
      <div className={`mt-1 h-10 w-36 ${SHIMMER}`} />
      <div className={`mt-1 h-5 w-32 ${SHIMMER}`} />
      <div className="mt-4 h-[200px] animate-pulse rounded bg-slate-800/30" />
    </div>
  );
}

export default function PoolDetailLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-6 w-64 animate-pulse rounded bg-slate-800/50" />
        <div className="h-4 w-96 animate-pulse rounded bg-slate-800/50" />
      </div>
      {/* Header card — mirrors PoolHeader: p-5 card, title row (text-xl ≈
          h-7) + 5-col stat grid. */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className={`h-7 w-40 ${SHIMMER}`} />
          <div className={`h-5 w-24 ${SHIMMER}`} />
          <div className={`h-5 w-16 ${SHIMMER}`} />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div key={`skel-stat-${i}`}>
              <div className={`h-4 w-20 ${SHIMMER}`} />
              <div className={`mt-1 h-5 w-24 ${SHIMMER}`} />
            </div>
          ))}
        </div>
      </div>
      {/* Health panel — exception-only in the real page (often renders
          nothing); a slim bar splits the difference with the full panel. */}
      <div className="h-12 animate-pulse rounded-lg border border-slate-800 bg-slate-900/30" />
      {/* Charts row — mirrors PoolChartsRow: two 200px chart cards +
          reserves panel in a 3-col grid. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCardSkeleton />
        <ChartCardSkeleton />
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
          <div className={`h-5 w-24 ${SHIMMER}`} />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-as-key
              <div key={`skel-reserve-${i}`} className={`h-4 ${SHIMMER}`} />
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-1 border-b border-slate-800">
        {Array.from({ length: 7 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`skel-tab-${i}`}
            className="h-9 w-24 animate-pulse rounded-t bg-slate-800/50"
          />
        ))}
      </div>
      <TableSkeleton rows={10} cols={6} />
    </div>
  );
}
