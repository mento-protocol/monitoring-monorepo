const LOADING_MONITOR_KEYS = [
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "aa",
  "ab",
  "ac",
];
const LOADING_SOURCE_KEYS = ["bitvavo-eur", "kraken-eur", "kraken-usd"];
const LOADING_SOURCE_EVIDENCE_KEYS = [
  "ac",
  "ad",
  "ae",
  "af",
  "ag",
  "ah",
  "ai",
  "aj",
  "ak",
  "al",
];

function LoadingMonitors(): React.JSX.Element {
  return (
    <section data-testid="peg-skeleton-monitors" className="space-y-3">
      <div className="h-5 w-48 animate-pulse rounded bg-slate-800" />
      <article className="space-y-4 rounded-lg border border-slate-800 bg-slate-950/35 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="h-4 w-16 animate-pulse rounded bg-slate-800" />
            <div className="h-5 w-36 animate-pulse rounded bg-slate-800" />
          </div>
          <div className="h-7 w-24 animate-pulse rounded-full bg-slate-800" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {LOADING_MONITOR_KEYS.map((key) => (
            <div
              key={key}
              className={`${key === "ab" || key === "ac" ? "h-16" : "h-24"} animate-pulse rounded-md border border-slate-800/80 bg-slate-950/40`}
            />
          ))}
        </div>
      </article>
    </section>
  );
}

function LoadingSources(): React.JSX.Element {
  return (
    <section data-testid="peg-skeleton-sources" className="space-y-3">
      <div className="h-5 w-44 animate-pulse rounded bg-slate-800" />
      {LOADING_SOURCE_KEYS.map((sourceKey) => (
        <article
          key={sourceKey}
          className="space-y-4 rounded-lg border border-slate-800 bg-slate-950/35 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="h-5 w-40 animate-pulse rounded bg-slate-800" />
              <div className="h-4 w-52 animate-pulse rounded bg-slate-800" />
            </div>
            <div className="h-7 w-44 animate-pulse rounded-full bg-slate-800" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {LOADING_SOURCE_EVIDENCE_KEYS.map((key) => (
              <div
                key={`${sourceKey}-${key}`}
                className={`${sourceKey === "kraken-usd" && key === "al" ? "h-24" : "h-20"} animate-pulse rounded-md border border-slate-800/80 bg-slate-950/40`}
              />
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

export function PegMonitoringLoading(): React.JSX.Element {
  return (
    <section aria-label="Loading peg monitoring" className="space-y-6">
      <div
        data-testid="peg-skeleton-status"
        className="h-12 animate-pulse rounded-lg border border-slate-800 bg-slate-900/45"
      />
      <div data-testid="peg-skeleton-snapshot" className="space-y-3">
        <div className="h-7 w-28 animate-pulse rounded bg-slate-800" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {["a", "b", "c", "d", "e"].map((key) => (
            <div
              key={key}
              className="h-28 animate-pulse rounded-md border border-slate-800 bg-slate-950/40"
            />
          ))}
        </div>
      </div>
      <div
        data-testid="peg-skeleton-package"
        className="space-y-6 rounded-xl border border-slate-800 bg-slate-900/45 p-4 sm:p-6"
      >
        <div
          data-testid="peg-skeleton-package-header"
          className="flex flex-wrap items-start justify-between gap-4"
        >
          <div className="h-12 w-1/3 animate-pulse rounded bg-slate-800" />
        </div>
        <section data-testid="peg-skeleton-structural" className="space-y-3">
          <div className="h-5 w-40 animate-pulse rounded bg-slate-800" />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            {["f", "g", "h", "i", "j", "k"].map((key) => (
              <div
                key={key}
                className="h-20 animate-pulse rounded-md border border-slate-800/80 bg-slate-950/40"
              />
            ))}
          </div>
        </section>
        <section data-testid="peg-skeleton-policy" className="space-y-3">
          <div className="h-5 w-48 animate-pulse rounded bg-slate-800" />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {["l", "m", "n", "o", "p", "q", "r", "s"].map((key) => (
              <div
                key={key}
                className="h-20 animate-pulse rounded-md border border-slate-800/80 bg-slate-950/40"
              />
            ))}
          </div>
        </section>
        <LoadingMonitors />
        <LoadingSources />
      </div>
    </section>
  );
}
