import { TableSkeleton } from "@/components/skeletons";

// Route-level fallback for /volume, rendered during the server session-await —
// BEFORE the client reads URL-state (venue/range) or the auth session. It
// therefore can't conditionally match (the chart is absent for range=24h; the
// venue insight/aggregator sections are venue-specific). It reserves the
// always-present, fixed-size blocks of VolumePageView for the common (7d, v3)
// case so the skeleton→content swap doesn't shift: header (title + toggle
// controls) → 200px chart card → 3 KPI tiles → venue table. A single live region
// wraps the presentational child skeletons.
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
          section, the title + 3xl/4xl headline + h-5 change row + range buttons,
          then the mt-4 200px plot (ROW_CHART_HEIGHT_PX). Reserving the full card
          header (not just the plot) keeps the KPI tiles from being pushed down. */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm">
              <span className="inline-block h-[1em] w-32 animate-pulse rounded bg-slate-800/50 align-middle" />
            </p>
            <p className="mt-1 text-3xl font-semibold sm:text-4xl">
              <span className="inline-block h-[1em] w-36 animate-pulse rounded bg-slate-800/60 align-middle" />
            </p>
            <div className="mt-1 flex h-5 items-center">
              <span className="h-3 w-24 animate-pulse rounded bg-slate-800/40" />
            </div>
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
      <TableSkeleton rows={10} presentational />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
