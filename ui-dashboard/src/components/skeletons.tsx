const SHIMMER = "animate-pulse rounded bg-slate-800/50";

type SkeletonAriaProps = {
  // When true, strips role/aria-live from this component so a parent
  // (e.g. PageShellSkeleton) can provide a single live-region wrapper
  // instead of each child announcing independently.
  presentational?: boolean;
};

function liveRegion(
  label: string,
  presentational: boolean | undefined,
): Record<string, string> {
  if (presentational) return {};
  return { role: "status", "aria-live": "polite", "aria-label": label };
}

export function TableSkeleton({
  rows = 8,
  cols = 5,
  presentational,
}: { rows?: number; cols?: number } & SkeletonAriaProps) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30"
      {...liveRegion("Loading table", presentational)}
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
      {!presentational && <span className="sr-only">Loading…</span>}
    </div>
  );
}

export function TileGridSkeleton({
  count = 4,
  presentational,
}: { count?: number } & SkeletonAriaProps) {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      {...liveRegion("Loading metrics", presentational)}
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
      {!presentational && <span className="sr-only">Loading…</span>}
    </div>
  );
}

export function ChartSkeleton({
  aspect = "16 / 9",
  presentational,
}: { aspect?: string } & SkeletonAriaProps) {
  return (
    <div
      className={`w-full rounded-lg border border-slate-800 bg-slate-900/30 ${SHIMMER}`}
      style={{ aspectRatio: aspect }}
      {...liveRegion("Loading chart", presentational)}
    >
      {!presentational && <span className="sr-only">Loading…</span>}
    </div>
  );
}

export function PageShellSkeleton() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-live="polite"
      aria-label="Loading"
    >
      <div className={`h-6 w-48 ${SHIMMER}`} aria-hidden />
      <TileGridSkeleton presentational />
      <TableSkeleton presentational />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
