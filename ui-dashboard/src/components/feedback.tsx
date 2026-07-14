export function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key
        <div
          key={`skel-row-${i}`}
          className="h-10 animate-pulse rounded bg-slate-800/50"
        />
      ))}
    </div>
  );
}

// A table-shaped loading skeleton (header + real-table row rhythm) lives in
// `skeletons.tsx` as `<TableSkeleton variant="rows" rows={n} />` — a single
// source of truth for table-skeleton geometry, wired through the shared
// `liveRegion()` helper. Prefer that over adding a second table skeleton here.

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

/** Message for a failed SWR revalidation that left last-known `fallbackData`
 *  on screen, or `null` when there's no error. With SSR `fallbackData` present,
 *  SWR keeps the last-good `data` visible while setting `error`, so a widget
 *  must disclose that its content is the last confirmed state, not a fresh poll
 *  (issue #1257). `subject` names the data ("Breaker status", "Market hours"). */
function staleRefreshMessage(subject: string, error: unknown): string | null {
  if (error == null) return null;
  const detail = error instanceof Error ? error.message : String(error);
  return `${subject} refresh failed — showing the last confirmed state (${detail})`;
}

/** Shared stale-refresh affordance: renders an `ErrorBox` disclosing that a
 *  widget is showing last-known `fallbackData` after a failed revalidation, or
 *  `null` when there's no error. Reused by `BreakerPanel` and `MarketHoursPill`
 *  so both siblings surface the identical "showing the last confirmed state"
 *  indicator (issue #1257). `className` positions the block for the caller
 *  (e.g. `mb-4` in a strip, `w-full` to drop onto its own header-row line). */
export function StaleRefreshNotice({
  subject,
  error,
  className,
}: {
  subject: string;
  error: unknown;
  className: string;
}): React.ReactElement | null {
  const message = staleRefreshMessage(subject, error);
  if (message === null) return null;
  return (
    <div className={className}>
      <ErrorBox message={message} />
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
  subtitle?: string | undefined;
  /** Optional link — makes the value clickable (opens in new tab) */
  href?: string | undefined;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 min-h-[88px]">
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
      {subtitle && <p className="mt-1.5 text-xs text-slate-500">{subtitle}</p>}
    </div>
  );
}
