// Sidebar + main column skeleton matching page.tsx's grid. ARIA live region
// lives on the inner skeleton primitives so we don't nest live regions.

export default function AddressDetailLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-4 w-48 animate-pulse rounded bg-slate-800/50" />
        <div className="h-7 w-72 animate-pulse rounded bg-slate-800/50" />
        <div className="h-4 w-96 animate-pulse rounded bg-slate-800/50" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside
          className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4"
          aria-label="Loading label form"
        >
          {Array.from({ length: 4 }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div key={`skel-form-${i}`} className="space-y-2">
              <div className="h-3 w-20 animate-pulse rounded bg-slate-800/50" />
              <div className="h-9 w-full animate-pulse rounded bg-slate-800/50" />
            </div>
          ))}
        </aside>
        <div
          className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3"
          aria-label="Loading forensic report"
        >
          <div className="h-5 w-40 animate-pulse rounded bg-slate-800/50" />
          {Array.from({ length: 8 }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div
              key={`skel-line-${i}`}
              className="h-4 animate-pulse rounded bg-slate-800/50"
              style={{ width: `${60 + ((i * 7) % 35)}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
