// Route-level navigation skeletons. Not for in-page loading states — use
// `<Skeleton rows>` from components/feedback.tsx when SWR is mid-fetch after
// the page has mounted.

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

export function TableSkeleton({
  rows = 8,
  cols = 5,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30"
      role="status"
      aria-live="polite"
      aria-label="Loading table"
    >
      <div className="flex gap-4 border-b border-slate-800 bg-slate-900/50 px-4 py-3">
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} className={`h-3 flex-1 ${SHIMMER}`} />
        ))}
      </div>
      <div className="divide-y divide-slate-800/50">
        {Array.from({ length: rows }, (_, rowIdx) => (
          <div key={rowIdx} className="flex gap-4 px-4 py-3">
            {Array.from({ length: cols }, (_, colIdx) => (
              <div key={colIdx} className={`h-4 flex-1 ${SHIMMER}`} />
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function TileGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      role="status"
      aria-live="polite"
      aria-label="Loading metrics"
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flex min-h-[88px] flex-col justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4"
        >
          <div className={`h-3 w-2/3 ${SHIMMER}`} />
          <div className={`mt-2 h-7 w-1/2 ${SHIMMER}`} />
          <div className={`mt-2 h-3 w-1/3 ${SHIMMER}`} />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function ChartSkeleton({ aspect = "16 / 9" }: { aspect?: string }) {
  return (
    <div
      className={`w-full rounded-lg border border-slate-800 bg-slate-900/30 ${SHIMMER}`}
      style={{ aspectRatio: aspect }}
      role="status"
      aria-live="polite"
      aria-label="Loading chart"
    >
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function PageShellSkeleton() {
  return (
    <div className="space-y-6">
      <div className={`h-6 w-48 ${SHIMMER}`} aria-hidden />
      <TileGridSkeleton />
      <TableSkeleton />
    </div>
  );
}
