import { PoolsTableSkeleton } from "@/components/pools-table-skeleton";
import { ROW_CHART_HEIGHT_PX } from "@/lib/plot";

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Homepage-shaped route loading UI (SSR await in `(home)/page.tsx` +
// client-side nav to `/`). Mirrors `page-client.tsx`'s `GlobalContent`:
// header, two chart cards, a 4-tile KPI row, and the "All Pools" table, so
// the swap from skeleton to real content reads as fill-in rather than a full
// repaint.
//
// Lives in the `(home)` route group so this shape stays scoped to `/` alone.
// The group changes no URL — it just makes this the nearest Suspense boundary
// for `(home)/page.tsx` only. Every other route falls back to the generic
// `app/loading.tsx` (`PageShellSkeleton`) it used before this change, so a
// homepage-shaped skeleton can't leak onto `/entities`, `/integrations`,
// `/sign-in`, or any other segment that suspends without a nearer loading.tsx.
// `/pools` is the one exception: it has its own shape-matched
// `pools/loading.tsx`.

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

      {/* Pools table — mirrors the "All Pools" section, which renders the
          exact same GlobalPoolsTable component as /pools. Sized via
          `PoolsTableSkeleton` (POOLS_TABLE_SKELETON_ROWS rows at the
          pools-table-measured 45px header / 58px row rhythm, not the shared
          TableSkeleton's 36/44 — see `@/components/pools-table-skeleton`)
          so this route fallback matches /pools's fallback and the real
          table exactly, instead of under-reserving on a slow SSR resolve. */}
      <section>
        <div className={`mb-3 h-6 w-24 ${SHIMMER}`} />
        <PoolsTableSkeleton presentational showFilters />
      </section>

      <span className="sr-only">Loading…</span>
    </div>
  );
}
