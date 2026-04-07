export function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded bg-slate-800/50" />
      ))}
    </div>
  );
}

export function EmptyBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/30 py-12 text-center text-sm text-slate-500">
      {message}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-400"
      role="alert"
    >
      {message}
    </div>
  );
}

const TILE_CONTAINER =
  "rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between";

export function MultiPeriodTile({
  label,
  periods,
  subtitle,
}: {
  label: string;
  periods: { label: string; value: string }[];
  subtitle?: string;
}) {
  return (
    <div className={`${TILE_CONTAINER} min-h-[120px]`}>
      <div>
        <p className="text-sm text-slate-400 mb-2">{label}</p>
        {periods.map((p, i) => (
          <div
            key={p.label}
            className={`flex items-baseline justify-between${i === 0 ? "" : " mt-1"}`}
          >
            <p
              className={`font-semibold font-mono ${i === 0 ? "text-2xl text-white" : "text-lg text-slate-300"}`}
            >
              {p.value}
            </p>
            <span
              className={`text-xs ml-2 ${i === 0 ? "text-slate-400" : "text-slate-500"}`}
            >
              {p.label}
            </span>
          </div>
        ))}
      </div>
      {subtitle && (
        <p className="mt-2 text-xs text-slate-500 min-h-4">{subtitle}</p>
      )}
    </div>
  );
}

export function Tile({
  label,
  value,
  subtitle,
  href,
}: {
  label: string;
  value: string;
  subtitle?: string;
  /** Optional link — makes the value clickable (opens in new tab) */
  href?: string;
}) {
  return (
    <div className={`${TILE_CONTAINER} min-h-[88px]`}>
      <div>
        <p className="text-sm text-slate-400">{label}</p>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${label}: ${value}`}
            className="mt-1 block text-2xl font-semibold text-white font-mono hover:text-indigo-400 transition-colors"
          >
            {value}
          </a>
        ) : (
          <p className="mt-1 text-2xl font-semibold text-white font-mono">
            {value}
          </p>
        )}
      </div>
      <p
        className="mt-2 text-xs text-slate-500 min-h-4"
        aria-hidden={!subtitle}
      >
        {subtitle}
      </p>
    </div>
  );
}
