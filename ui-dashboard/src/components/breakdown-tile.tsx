// ---------------------------------------------------------------------------
// BreakdownTile — shows a "Total" headline value with 24h / 7d / 30d below
// ---------------------------------------------------------------------------

export function BreakdownTile({
  label,
  total,
  sub24h,
  sub7d,
  sub30d,
  isLoading,
  hasError,
  format,
  totalPrefix = "",
  href,
  subtitle,
}: {
  label: string;
  total: number | null;
  sub24h: number | null;
  sub7d: number | null;
  sub30d: number | null;
  isLoading: boolean;
  hasError: boolean;
  format: (v: number) => string;
  /** Prefix for the headline value only (e.g. "≈ "), not applied to sub-values */
  totalPrefix?: string;
  href?: string;
  subtitle?: string;
}) {
  const mainValue = isLoading
    ? "…"
    : total === null
      ? "N/A"
      : `${totalPrefix}${format(total)}`;

  const subItems =
    !isLoading && !hasError && total !== null
      ? [
          { label: "24h", value: sub24h },
          { label: "7d", value: sub7d },
          { label: "30d", value: sub30d },
        ]
      : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px]">
      <div>
        <p className="text-sm text-slate-400">{label}</p>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${label}: ${mainValue}`}
            className="mt-1 block text-2xl font-semibold text-white font-mono hover:text-indigo-400 transition-colors"
          >
            {mainValue}
          </a>
        ) : (
          <p className="mt-1 text-2xl font-semibold text-white font-mono">
            {mainValue}
          </p>
        )}
        {subItems && (
          <div className="mt-1.5 flex gap-3 text-sm font-mono">
            {subItems.map((s) => (
              <span key={s.label}>
                <span className="text-slate-500">{s.label}</span>{" "}
                <span className="text-slate-400">
                  {s.value === null ? "N/A" : format(s.value)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
      <p
        className="mt-2 text-xs text-slate-500 min-h-4"
        aria-hidden={!subtitle && !hasError}
      >
        {hasError ? "Some chains failed to load" : subtitle}
      </p>
    </div>
  );
}
