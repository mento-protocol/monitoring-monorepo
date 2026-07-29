const cards = ["furthest", "warning", "freshness"];
const evidenceItems = ["market", "sources", "pool", "breaker"];

function Bar({ className }: { className: string }): React.JSX.Element {
  return <div className={`rounded bg-slate-800 ${className}`} />;
}

export function PegMonitoringLoading(): React.JSX.Element {
  return (
    <section
      aria-label="Loading peg monitoring"
      className="space-y-5 animate-pulse"
    >
      <div
        data-testid="peg-skeleton-status"
        className="rounded-xl border border-slate-800 bg-slate-900/45 p-5"
      >
        <Bar className="h-5 w-44" />
      </div>
      <div
        data-testid="peg-skeleton-headlines"
        className="grid gap-3 md:grid-cols-3"
      >
        {cards.map((card) => (
          <div
            key={card}
            className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/45 p-5"
          >
            <Bar className="h-3 w-32" />
            <Bar className="h-7 w-3/4" />
            <Bar className="h-3 w-2/3" />
          </div>
        ))}
      </div>
      <article
        data-testid="peg-skeleton-scorecard"
        className="rounded-xl border border-slate-800 bg-slate-900/45 p-5"
      >
        <div className="grid gap-6 xl:grid-cols-[minmax(13rem,0.8fr)_minmax(20rem,1.4fr)_minmax(13rem,0.8fr)] xl:items-center">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Bar className="h-6 w-36" />
              <Bar className="h-7 w-20 rounded-full" />
            </div>
            <Bar className="h-9 w-44" />
            <Bar className="h-3 w-56 max-w-full" />
          </div>
          <div className="space-y-3">
            <div className="flex justify-between gap-3">
              <Bar className="h-4 w-28" />
              <Bar className="h-4 w-36" />
            </div>
            <Bar className="h-3 w-full rounded-full" />
            <div className="flex justify-between gap-3">
              <Bar className="h-3 w-12" />
              <Bar className="h-3 w-24" />
              <Bar className="h-3 w-24" />
            </div>
          </div>
          <div className="space-y-4 rounded-lg border border-slate-800 p-4">
            <Bar className="h-3 w-32" />
            <Bar className="h-5 w-full" />
            <Bar className="h-3 w-3/4" />
          </div>
        </div>
        <div className="mt-5 grid gap-4 border-t border-slate-800 pt-4 sm:grid-cols-4">
          {evidenceItems.map((item) => (
            <div key={item} className="space-y-2">
              <Bar className="h-3 w-20" />
              <Bar className="h-4 w-32 max-w-full" />
            </div>
          ))}
        </div>
      </article>
      <div
        data-testid="peg-skeleton-evidence"
        className="rounded-xl border border-slate-800 bg-slate-950/35 p-5"
      >
        <Bar className="h-5 w-40" />
      </div>
    </section>
  );
}
