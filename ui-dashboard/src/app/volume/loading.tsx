import { ChartSkeleton, TableSkeleton } from "@/components/skeletons";

// Route-level fallback for /volume. The page is an async Server Component that
// `await`s the auth session before its Suspense boundary, so without this the
// whole segment blocks on the session read and paints nothing on client nav.
// The order and grid MIRROR VolumePageView (header → chart → 3 KPI tiles →
// venue table) so the skeleton→content swap reserves matching space and doesn't
// shift layout. A single live region wraps the presentational child skeletons.
export default function VolumeLoading() {
  return (
    <div
      className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6"
      role="status"
      aria-live="polite"
      aria-label="Loading volume"
    >
      <div className="space-y-2">
        <div className="h-8 w-56 animate-pulse rounded bg-slate-800/50" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-slate-800/50" />
      </div>
      <ChartSkeleton presentational />
      {/* Mirrors VolumeKpiTiles: grid-cols-1 sm:grid-cols-3, three tiles. */}
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
