import { TableSkeleton } from "@/components/skeletons";
import { ROW_CHART_HEIGHT_PX } from "@/lib/plot";

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Homepage-shaped route loading UI (SSR await in `page.tsx` + client-side
// nav to `/`). Mirrors `page-client.tsx`'s `GlobalContent`: header, two
// chart cards, a 4-tile KPI row, and the "All Pools" table, so the swap from
// skeleton to real content reads as fill-in rather than a full repaint.
// Scoped to `/` only — it is the nearest Suspense boundary for the whole
// `app` segment, so leaving it homepage-shaped would leak onto every other
// route that suspends on its own async awaits without a nearer loading.tsx.
// `/pools`, `/entities`, `/integrations`, and `/sign-in` each suspend
// (server awaits: fetches/session/Redis reads) and each has its own
// loading.tsx to stay clear of this shape. Routes that render synchronously
// (`/cdps`, `/revenue`, `/stables`, `/bridge-flows`, etc.) never suspend and
// never show this boundary at all.

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

// Mirrors BreakdownTile's geometry (label, mt-1 text-2xl value, mt-1.5
// 24h/7d/30d subrow, mt-2 subtitle line) rather than the shorter
// LPs/Swaps/Traders `Tile` shape. Swap Fees is the only BreakdownTile in
// the KPI row, but CSS Grid's default row-stretch means IT sets the row's
// real height (~140px with a single-line subtitle, more if the subtitle
// wraps to two lines) — a placeholder built off the shorter `Tile` shape
// under-reserves the whole row.
function KpiTileSkeleton() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px]">
      <div>
        <div className={`h-5 w-16 ${SHIMMER}`} />
        <div className={`mt-1 h-8 w-24 ${SHIMMER}`} />
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          <div className={`h-5 w-8 ${SHIMMER}`} />
          <div className={`h-5 w-8 ${SHIMMER}`} />
          <div className={`h-5 w-8 ${SHIMMER}`} />
        </div>
      </div>
      <div className={`mt-2 h-4 w-40 ${SHIMMER}`} />
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
          Swap Fees / LPs / Swaps / Traders tiles. See KpiTileSkeleton for
          why every cell uses the taller Swap Fees (BreakdownTile) shape. */}
      <section>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <KpiTileSkeleton key={`kpi-${i}`} />
          ))}
        </div>
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
