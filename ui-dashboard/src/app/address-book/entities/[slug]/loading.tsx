export default function EntityDetailLoading() {
  return (
    <div
      className="mx-auto max-w-3xl space-y-6 px-4 py-8"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading entity profile</span>
      <div className="space-y-2">
        <div className="h-3 w-24 animate-pulse rounded bg-slate-800/50" />
        <div className="h-7 w-64 max-w-full animate-pulse rounded bg-slate-800/50" />
        <div className="h-4 w-24 animate-pulse rounded bg-slate-800/50" />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-800">
        <div className="h-11 border-b border-slate-800 bg-slate-900" />
        {Array.from({ length: 5 }, (_, index) => (
          <div
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            key={index}
            className="h-11 animate-pulse border-b border-slate-800 bg-slate-900/50 last:border-b-0"
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-slate-800 bg-slate-900/50" />
    </div>
  );
}
