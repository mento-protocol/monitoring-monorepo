import {
  ChartSkeleton,
  TableSkeleton,
  TileGridSkeleton,
} from "@/components/skeletons";

// Route-level fallback for /volume. The page is an async Server Component that
// `await`s the auth session before its Suspense boundary, so without this the
// whole segment blocks on the session read and paints nothing on client nav.
// The layout mirrors VolumePageView (header → KPI tiles → chart → venue table)
// inside the same max-w-7xl container so the skeleton→content swap reserves
// matching space and doesn't shift layout. A single live region wraps the
// presentational child skeletons.
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
      <TileGridSkeleton presentational />
      <ChartSkeleton presentational />
      <TableSkeleton rows={10} presentational />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
