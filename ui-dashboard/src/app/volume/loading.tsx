import { TableSkeleton } from "@/components/skeletons";

// Route-level fallback for /volume, rendered during the server session-await —
// BEFORE the client reads URL-state (venue/range) or the auth session. It
// therefore can't conditionally match (the chart is absent for range=24h; the
// venue insight/aggregator sections are venue-specific). It reserves the
// always-present, fixed-size blocks of VolumePageView for the common (7d, v3)
// case so the skeleton→content swap doesn't shift: header (title + toggle
// controls) → 200px chart card → 3 KPI tiles → flow insights → top traders →
// aggregator breakdown. A single live region wraps the presentational child
// skeletons.
//
// The below-the-fold three sections mirror V3VolumeSection's default (7d,
// v3) layout — the venue this route falls back to. Non-default deep links
// (24h, v2) still mismatch somewhat here; that's an accepted tradeoff (this
// file can't read search params before the client mounts). Notably, the top
// traders table is reserved as a single full-width table with no side
// column: `TopPoolsList` only renders alongside the per-pool chart for the
// 30d/90d/all ranges (`RANGES_WITH_CHART` in `page-client.tsx`), which the
// default 7d view never reaches.
export default function VolumeLoading() {
  return (
    <div
      className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6"
      role="status"
      aria-live="polite"
      aria-label="Loading volume"
    >
      {/* Header: title/subtitle + the venue/range toggle groups, matching
          VolumePageHeader's flex-wrap justify-between control row. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-8 w-56 animate-pulse rounded bg-slate-800/50" />
          <div className="h-4 w-96 max-w-full animate-pulse rounded bg-slate-800/50" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-9 w-44 animate-pulse rounded-md bg-slate-800/50" />
          <div className="h-9 w-28 animate-pulse rounded-md bg-slate-800/50" />
        </div>
      </div>
      {/* Chart card: mirrors TimeSeriesChartCard's loading state — the p-5/sm:p-6
          section, the title + 3xl/4xl headline + range buttons, then the mt-4
          200px plot (ROW_CHART_HEIGHT_PX). Reserving the full card header (not
          just the plot) keeps the KPI tiles from being pushed down. No change
          row is reserved: the common 7d/v3 fallback renders DailyVolumeChart,
          which passes reserveDeltaRow={false} and never shows a delta line
          loading or loaded — reserving one here would shift the KPI tiles down
          by ~20px on the skeleton→content swap. */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm">
              <span className="inline-block h-[1em] w-32 animate-pulse rounded bg-slate-800/50 align-middle" />
            </p>
            <p className="mt-1 text-3xl font-semibold sm:text-4xl">
              <span className="inline-block h-[1em] w-36 animate-pulse rounded bg-slate-800/60 align-middle" />
            </p>
          </div>
          <div className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5">
            {Array.from({ length: 4 }, (_, i) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-as-key
              <span
                key={`vol-range-${i}`}
                className="h-6 w-9 animate-pulse rounded bg-slate-800/40"
              />
            ))}
          </div>
        </div>
        <div className="mt-4 h-[200px] animate-pulse rounded bg-slate-800/30" />
      </section>
      {/* KPI tiles: mirrors VolumeKpiTiles (grid-cols-1 sm:grid-cols-3, 3 tiles). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`vol-kpi-${i}`}
            className="flex min-h-[88px] flex-col justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4"
          >
            <div className="h-3 w-2/3 animate-pulse rounded bg-slate-800/50" />
            <div className="mt-2 h-7 w-1/2 animate-pulse rounded bg-slate-800/50" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-slate-800/50" />
          </div>
        ))}
      </div>
      {/* Flow insights: heading + 3-panel grid mirroring V3FlowInsights
          (Cohort / Corridor / Outlier). This route-level fallback can't know
          venue/range, so each panel reserves a generic sized block rather
          than replicating the panels' internal row shapes — that detail
          lives in v3-flow-insight-panels.tsx's own client loading branch. */}
      <div className="space-y-3">
        <div className="h-4 w-40 animate-pulse rounded bg-slate-800/50" />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div
              key={`vol-insight-panel-${i}`}
              className="rounded-lg border border-slate-800 bg-slate-900/50 p-4"
              style={{ height: 480 }}
            >
              <div className="mb-3 h-3 w-32 animate-pulse rounded bg-slate-800/50" />
              <div className="space-y-2">
                {Array.from({ length: 8 }, (_, r) => (
                  // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                  <div
                    key={`vol-insight-row-${i}-${r}`}
                    className="h-5 animate-pulse rounded bg-slate-800/30"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* Top traders: heading + main table skeleton (header + measured row
          rhythm), mirroring V3VolumeSection's "Top traders" table. */}
      <div className="space-y-3">
        <div className="h-4 w-40 animate-pulse rounded bg-slate-800/50" />
        <TableSkeleton rows={10} variant="rows" presentational />
      </div>
      {/* Aggregator breakdown: heading + 230px chart card + table skeleton,
          mirroring AggregatorBreakdownSection. Row count matches
          AGGREGATOR_TABLE_SKELETON_ROWS in aggregator-breakdown-section.tsx —
          keep both in sync if that changes. */}
      <div className="space-y-3">
        <div className="h-4 w-64 animate-pulse rounded bg-slate-800/50" />
        <div className="h-[230px] animate-pulse rounded-lg border border-slate-800 bg-slate-900/30" />
        <TableSkeleton rows={6} variant="rows" presentational />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
