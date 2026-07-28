export default function EntityDirectoryLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <span className="sr-only">Loading entities</span>
      <div className="space-y-2">
        <div className="h-6 w-40 animate-pulse rounded bg-slate-800/50" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded bg-slate-800/50" />
      </div>
      <div className="h-10 border-b border-slate-800">
        <div className="h-full w-40 animate-pulse rounded-t bg-slate-800/30" />
      </div>
      <div className="w-full space-y-4">
        <div className="h-9 w-full max-w-sm animate-pulse rounded-lg bg-slate-800/50" />
        <div className="h-3 w-80 max-w-full animate-pulse rounded bg-slate-800/50" />
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[1.35fr_0.8fr_1.6fr_0.7fr_1.1fr] gap-4 border-b border-slate-800 bg-slate-900/50 px-4 py-3">
              {Array.from({ length: 5 }, (_, index) => (
                <div
                  // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                  key={index}
                  className="h-3 w-16 animate-pulse rounded bg-slate-800/50"
                />
              ))}
            </div>
            {Array.from({ length: 8 }, (_, index) => (
              <div
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                key={index}
                className="grid grid-cols-[1.35fr_0.8fr_1.6fr_0.7fr_1.1fr] items-center gap-4 border-b border-slate-800 px-4 py-3 last:border-b-0"
              >
                <div className="h-4 w-36 animate-pulse rounded bg-slate-800/50" />
                <div className="h-5 w-20 animate-pulse rounded-full bg-slate-800/50" />
                <div className="h-5 w-32 animate-pulse rounded bg-slate-800/50" />
                <div className="ml-auto h-4 w-8 animate-pulse rounded bg-slate-800/50" />
                <div className="h-3 w-28 animate-pulse rounded bg-slate-800/50" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
