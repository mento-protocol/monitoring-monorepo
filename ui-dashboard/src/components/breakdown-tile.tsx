// BreakdownTile — shows a "Total" headline value with 24h / 7d / 30d below

import type { ReactNode } from "react";

export function BreakdownTile({
  label,
  total,
  sub24h,
  sub7d,
  sub30d,
  isLoading,
  hasError,
  format,
  subFormat,
  totalPrefix = "",
  href,
  subtitle,
  badge,
  emptyStateMessage = "No data this window",
}: {
  label: string;
  total: number | null;
  sub24h: number | null;
  sub7d: number | null;
  sub30d: number | null;
  isLoading: boolean;
  hasError: boolean;
  format: (v: number) => string;
  /** Formatter for the 24h/7d/30d sub-values when they carry different units
   * than the headline (e.g. a % change under a $ total). Defaults to `format`. */
  subFormat?: ((v: number) => string) | undefined;
  /** Prefix for the headline value only (e.g. "≈ "), not applied to sub-values */
  totalPrefix?: string | undefined;
  href?: string | undefined;
  subtitle?: string | undefined;
  /** Optional element rendered on the title row, right-aligned — e.g. a
   * token/chain pill on the mover tiles. */
  badge?: ReactNode;
  /** Shown in place of the 24h/7d/30d rows when a caller legitimately
   * resolves with `total === null` post-load (e.g. MoverTile has no
   * expansion/contraction this window, or a bridge window had zero
   * transfers) — as opposed to still `isLoading` or `hasError`. Defaults to
   * a generic message so existing callers don't need to opt in. */
  emptyStateMessage?: string;
}) {
  const formatSub = subFormat ?? format;
  const mainValue = isLoading
    ? "…"
    : total === null
      ? "N/A"
      : `${totalPrefix}${format(total)}`;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px]">
      <div>
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-slate-400">{label}</p>
          {badge}
        </div>
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
        <BreakdownSubRows
          isLoading={isLoading}
          hasError={hasError}
          total={total}
          sub24h={sub24h}
          sub7d={sub7d}
          sub30d={sub30d}
          formatSub={formatSub}
          emptyStateMessage={emptyStateMessage}
        />
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

const SUB_WINDOW_LABELS = ["24h", "7d", "30d"] as const;

/**
 * The 24h/7d/30d row under the headline value. Four mutually exclusive
 * states, all reserving the same footprint so the tile never resizes as
 * data resolves:
 *  - loading: shimmer placeholders (was 114 -> 164px on /stables before
 *    this reservation existed).
 *  - loaded with a total: the real formatted values (per-value "N/A" when
 *    an individual window is null but the headline isn't).
 *  - loaded with `total === null` and no error: the caller legitimately
 *    has nothing to report (MoverTile's `agg` is null with no
 *    expansion/contraction this window; a bridge window can resolve zero
 *    snapshots). Renders a muted empty-state message grid-stacked over an
 *    invisible copy of the row shapes, so the block's height is driven by
 *    the same flex-wrap it would take on while loading — at any tile
 *    width — without showing fake skeleton/placeholder rows.
 *  - hasError (whether or not a total resolved): renders an invisible copy
 *    of the row shapes, same technique as the empty state, with no visible
 *    message here — the "Some chains failed to load" text already renders
 *    on the subtitle line (see `BreakdownTile`). Reserves the same
 *    footprint so a loading-to-error or loaded-to-error transition doesn't
 *    shrink the tile.
 */
function BreakdownSubRows({
  isLoading,
  hasError,
  total,
  sub24h,
  sub7d,
  sub30d,
  formatSub,
  emptyStateMessage,
}: {
  isLoading: boolean;
  hasError: boolean;
  total: number | null;
  sub24h: number | null;
  sub7d: number | null;
  sub30d: number | null;
  formatSub: (v: number) => string;
  emptyStateMessage: string;
}): React.JSX.Element | null {
  if (isLoading || (!hasError && total !== null)) {
    const items = [
      { label: "24h", value: sub24h },
      { label: "7d", value: sub7d },
      { label: "30d", value: sub30d },
    ];
    return (
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm font-mono">
        {items.map((s) => (
          <span key={s.label}>
            <span className="text-slate-500">{s.label}</span>{" "}
            {isLoading ? (
              // Width tracks a representative formatted value (`formatUSD`/
              // `formatSignedUSD` land around "+$450.3K", ~7 mono chars ≈
              // 56px = w-14) so the flex-wrap line count while loading
              // matches the loaded rows. The old w-12 (48px) sat right on
              // the wrap boundary of the /stables lg tile (~256px inner):
              // loaded rows wrap to two lines there, and a placeholder that
              // narrow could round down to one, re-introducing a height jump.
              <span className="inline-block h-3 w-14 animate-pulse rounded bg-slate-800/50 align-middle" />
            ) : (
              <span className="text-slate-400 tabular-nums">
                {s.value === null ? "N/A" : formatSub(s.value)}
              </span>
            )}
          </span>
        ))}
      </div>
    );
  }

  if (!isLoading && !hasError && total === null) {
    return (
      <div className="mt-1.5 grid text-sm">
        <div
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono"
        >
          {SUB_WINDOW_LABELS.map((l) => (
            <span key={l}>
              <span>{l}</span>{" "}
              <span className="inline-block h-3 w-14 align-middle" />
            </span>
          ))}
        </div>
        <p className="col-start-1 row-start-1 self-center text-slate-500">
          {emptyStateMessage}
        </p>
      </div>
    );
  }

  // hasError, whether or not a total resolved. Reserve the same footprint
  // as the branches above via an invisible copy of the row shapes; the
  // visible error message renders on the subtitle line instead.
  return (
    <div className="mt-1.5 text-sm">
      <div
        aria-hidden="true"
        className="invisible flex flex-wrap gap-x-3 gap-y-0.5 font-mono"
      >
        {SUB_WINDOW_LABELS.map((l) => (
          <span key={l}>
            <span>{l}</span>{" "}
            <span className="inline-block h-3 w-14 align-middle" />
          </span>
        ))}
      </div>
    </div>
  );
}
