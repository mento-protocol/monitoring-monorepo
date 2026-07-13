// Mirrors PoolHeader's card shape: p-5 card, title row (text-xl ≈ h-7) + 5-col
// stat grid. Shared by the route's `loading.tsx` (SSR/Suspense fallback) and
// `PoolOverview`'s degraded fallback (`pool-detail-page-client.tsx`, used when
// the SSR prefetch missed and the client hasn't resolved a pool yet) so the two
// loading branches can't drift apart — issue #1222's audit found the previous
// 4-flat-bar `<Skeleton rows={4} />` degraded fallback was much smaller than
// the route skeleton's header-card shape.
const SHIMMER = "animate-pulse rounded bg-slate-800/50";

export function HeaderCardSkeleton({
  presentational,
}: {
  // When true, strips role/aria-live so a parent page-level live region
  // (e.g. the route `loading.tsx` Suspense fallback, which announces via its
  // trailing TableSkeleton) doesn't get a second nested live region.
  presentational?: boolean;
}) {
  return (
    <div
      className="rounded-lg border border-slate-800 bg-slate-900/60 p-5"
      {...(presentational
        ? {}
        : {
            role: "status" as const,
            "aria-live": "polite" as const,
            "aria-label": "Loading pool",
          })}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className={`h-7 w-40 ${SHIMMER}`} />
        <div className={`h-5 w-24 ${SHIMMER}`} />
        <div className={`h-5 w-16 ${SHIMMER}`} />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`header-skel-stat-${i}`}>
            <div className={`h-4 w-20 ${SHIMMER}`} />
            <div className={`mt-1 h-5 w-24 ${SHIMMER}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
