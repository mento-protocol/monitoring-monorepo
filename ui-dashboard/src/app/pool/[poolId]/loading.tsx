import { TableSkeleton } from "@/components/skeletons";
import { ROW_CHART_HEIGHT_PX } from "@/lib/plot";
import { HeaderCardSkeleton } from "./_components/header-card-skeleton";

// Matches the real pool detail layout: breadcrumb + header card + health bar
// + charts row + 7 tabs (see TABS in page.tsx) + a 6-column default table.
// The header/health/charts placeholders mirror the geometry of PoolHeader,
// HealthPanel, and PoolChartsRow (pool-detail-page-client.tsx) so the tab
// strip and table don't jump down when the real page streams in (CLS).
// ARIA announcement lives on TableSkeleton itself so we don't nest live
// regions.

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Mirrors TimeSeriesChartCard: p-5 sm:p-6 card, text-sm title, 3xl/4xl mono
// headline, an optional h-5 change row, then a plot area at ROW_CHART_HEIGHT_PX
// — the real constant (not a hardcoded class) so the skeleton can't drift if
// the chart height ever changes. `reserveDeltaRow` mirrors the card's prop of
// the same name: the TVL card can show a real week-over-week delta so it
// reserves the row, while the volume card always passes change={null} +
// reserveDeltaRow={false} and never renders one — reserving it here would
// leave the volume skeleton ~20px taller than the streamed-in card.
function ChartCardSkeleton({
  reserveDeltaRow = true,
}: {
  reserveDeltaRow?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className={`h-5 w-28 ${SHIMMER}`} />
      <div className={`mt-1 h-10 w-36 ${SHIMMER}`} />
      {reserveDeltaRow && <div className={`mt-1 h-5 w-32 ${SHIMMER}`} />}
      <div
        className="mt-4 animate-pulse rounded bg-slate-800/30"
        style={{ height: ROW_CHART_HEIGHT_PX }}
      />
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
          h-7) + 5-col stat grid. Shared with PoolOverview's degraded
          fallback via HeaderCardSkeleton so the two loading branches can't
          drift apart. `presentational` because the page-level live region
          lives on the trailing TableSkeleton below.

          Known residual: on FPMM pools *with* a trip-able breaker,
          PoolHeader's BreakerPanel now paints its real ~90px section (divider
          + 5-stat grid) on first content paint via the #1237 SSR prefetch,
          but this route skeleton still can't reserve it without becoming
          pool-type-aware (this component doesn't know the pool yet), so the
          loading.tsx→content boundary still grows by that section for those
          pools. Pools *without* a breaker now render null there (no skeleton,
          no collapse), so their boundary is stable. */}
      <HeaderCardSkeleton presentational />
      {/* Health panel — exception-only in the real page (often renders
          nothing); a slim bar splits the difference with the full panel. */}
      <div className="h-12 animate-pulse rounded-lg border border-slate-800 bg-slate-900/30" />
      {/* Charts row — mirrors PoolChartsRow: two 200px chart cards +
          reserves panel in a 3-col grid. First card = PoolTvlOverTimeChart
          (can show a delta → reserve the row); second = PoolVolumeOverTimeChart
          (change={null} + reserveDeltaRow={false} → no delta row). */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCardSkeleton />
        <ChartCardSkeleton reserveDeltaRow={false} />
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
