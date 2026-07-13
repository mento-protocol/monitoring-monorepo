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

// Measured real-table geometry (`table.tsx` `Row`/`Td`,
// `global-pools-table/pool-row.tsx` `Cell`): `<thead>` ≈ 36px, body rows
// ≈ 44px. The `variant="rows"` mode below reserves exactly this rhythm as a
// single full-width bar per row, so a client-fetched table that only knows a
// row count can drop this in without a skeleton→content height jump.
const TABLE_SKELETON_HEADER_HEIGHT_PX = 36;
const TABLE_SKELETON_ROW_HEIGHT_PX = 44;

export function TableSkeleton({
  rows = 8,
  cols = 5,
  variant = "columns",
  presentational,
}: {
  rows?: number;
  cols?: number;
  /**
   * `"columns"` (default): multi-column shimmer with `cols` cells per row —
   * the shape the route-level `loading.tsx` fallbacks use. `"rows"`: a single
   * full-width bar per row at the measured real-table geometry (header ≈36px,
   * rows ≈44px), for client-fetched tables that only know a row count. `cols`
   * is ignored in `"rows"` mode.
   */
  variant?: "columns" | "rows";
} & SkeletonAriaProps) {
  const measuredRows = variant === "rows";
  return (
    <div
      className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30"
      {...liveRegion("Loading table", presentational)}
    >
      {measuredRows ? (
        <div
          className="animate-pulse border-b border-slate-800 bg-slate-800/50"
          style={{ height: TABLE_SKELETON_HEADER_HEIGHT_PX }}
        />
      ) : (
        <div className="flex gap-4 border-b border-slate-800 bg-slate-900/50 px-4 py-3">
          {Array.from({ length: cols }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div key={`skel-th-${i}`} className={`h-3 flex-1 ${SHIMMER}`} />
          ))}
        </div>
      )}
      <div className="divide-y divide-slate-800/50">
        {Array.from({ length: rows }, (_, rowIdx) =>
          measuredRows ? (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div
              key={`skel-row-${rowIdx}`}
              className="animate-pulse bg-slate-800/30"
              style={{ height: TABLE_SKELETON_ROW_HEIGHT_PX }}
            />
          ) : (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div key={`skel-row-${rowIdx}`} className="flex gap-4 px-4 py-3">
              {Array.from({ length: cols }, (_, colIdx) => (
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                <div
                  key={`skel-cell-${rowIdx}-${colIdx}`}
                  className={`h-4 flex-1 ${SHIMMER}`}
                />
              ))}
            </div>
          ),
        )}
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
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key
        <div
          key={`skel-tile-${i}`}
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
