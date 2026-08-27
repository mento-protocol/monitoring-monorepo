// Header card + totals + op-list skeleton matching the loaded grid
// (trove-header-card.tsx / trove-lifetime-totals.tsx / trove-operations-list.tsx).
// Single source of truth for this route's loading geometry: the route's
// `loading.tsx` Suspense fallback (initial navigation) and
// `trove-detail-client.tsx`'s own SWR loading branches (post-hydration data
// fetch) both render this, so a client-side load never swaps a generic
// bar-list skeleton in over the page-shaped one and back — the geometry jump
// AGENTS.md's skeleton/content parity rule exists to avoid. ARIA live region
// lives on the trailing skeleton block so we don't nest live regions
// (mirrors address-book/[address]/loading.tsx).
//
// Two post-header blocks, matching the two sections the loaded view can
// show: TroveLifetimeTotals (conditional — only for a trove with
// redemption/liquidation history) and TroveOperationsList (always present).
// Which trove this is isn't known until data resolves, so the totals block
// is reserved unconditionally; a trove without that history loses a modest
// placeholder when it resolves, which is a smaller mismatch than the
// alternative — a whole card appearing with no skeleton anticipating it.

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

export function TroveDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className={`h-4 w-32 ${SHIMMER}`} />
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className={`h-7 w-64 ${SHIMMER}`} />
          <div className={`h-5 w-16 ${SHIMMER}`} />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div key={`trove-header-skel-${i}`}>
              <div className={`h-3 w-16 ${SHIMMER}`} />
              <div className={`mt-1 h-4 w-20 ${SHIMMER}`} />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 space-y-3">
        <div className={`h-4 w-56 ${SHIMMER}`} />
        <div className={`h-3 w-full max-w-md ${SHIMMER}`} />
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div key={`trove-totals-skel-${i}`}>
              <div className={`h-3 w-20 ${SHIMMER}`} />
              <div className={`mt-1 h-4 w-16 ${SHIMMER}`} />
            </div>
          ))}
        </div>
      </div>
      <div
        className="rounded-lg border border-slate-800 bg-slate-900/30 p-5 space-y-2"
        role="status"
        aria-live="polite"
        aria-label="Loading trove"
      >
        <div className={`h-5 w-40 ${SHIMMER}`} />
        {Array.from({ length: 5 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`trove-op-skel-${i}`} className={`h-10 ${SHIMMER}`} />
        ))}
      </div>
    </div>
  );
}
