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

// Real table row geometry (`table.tsx` `Row`/`Td`, `pool-row.tsx` `Cell`):
// header ~36-40px, rows ~44-48px. `Skeleton`'s bare h-10 (40px) bars with no
// header row understate a real table's height — this is a drop-in
// alternative (same `rows` prop) that reserves the header + row rhythm so
// call sites can migrate without a layout jump when they adopt it.
const TABLE_SKELETON_HEADER_HEIGHT_PX = 36;
const TABLE_SKELETON_ROW_HEIGHT_PX = 44;

export function TableRowsSkeleton({ rows }: { rows: number }) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-slate-800"
      role="status"
      aria-label="Loading table"
    >
      <div
        className="animate-pulse border-b border-slate-800 bg-slate-800/50"
        style={{ height: TABLE_SKELETON_HEADER_HEIGHT_PX }}
      />
      <div className="divide-y divide-slate-800/50">
        {Array.from({ length: rows }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`table-skel-row-${i}`}
            className="animate-pulse bg-slate-800/30"
            style={{ height: TABLE_SKELETON_ROW_HEIGHT_PX }}
          />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
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
