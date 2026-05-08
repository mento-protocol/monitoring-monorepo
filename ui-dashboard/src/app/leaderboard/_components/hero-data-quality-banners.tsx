"use client";

import { useMemo } from "react";
import { chainLabel } from "@mento-protocol/monitoring-config/chains";

/**
 * Two `role="status"` banners surfaced above the hero tiles when the
 * pre-rolled `LeaderboardWindowSnapshot` is missing data for one or more
 * chains. Drives off the `staleChains` and `degradedChains` lists from
 * `mergeHeroSnapshot` (see `lib/leaderboard-hero.ts`):
 *
 *   - **stale** (`snapshotDay < today - 2 UTC days`, rolling-window
 *     rows only): chain dropped from totals AND its today's partial
 *     dropped, so the banner copy reads "missing data".
 *
 *   - **degraded** (`snapshotDay = today - 2 days`, the canonical
 *     pre-first-swap-of-day state): snapshot kept in totals but
 *     yesterday's closed-day data isn't in either source, so the
 *     banner copy reads "recent-incomplete".
 *
 * Renders nothing when both lists are empty or when the parent says we
 * don't have authoritative data yet (`isLoading` / `hasError` — the
 * tiles already show `…` / `—` and a banner would be redundant noise).
 *
 * Lives in its own file so the parent page-client stays closer to the
 * 600-line soft cap (see repo-root AGENTS.md).
 */
export function HeroDataQualityBanners({
  staleChains,
  degradedChains,
  isLoading,
  hasError,
}: {
  staleChains: ReadonlyArray<number>;
  degradedChains: ReadonlyArray<number>;
  isLoading: boolean;
  hasError: boolean;
}) {
  const staleLabels = useMemo(
    () =>
      isLoading || hasError
        ? []
        : Array.from(new Set(staleChains)).map((id) => chainLabel(id)),
    [isLoading, hasError, staleChains],
  );
  const degradedLabels = useMemo(
    () =>
      isLoading || hasError
        ? []
        : Array.from(new Set(degradedChains)).map((id) => chainLabel(id)),
    [isLoading, hasError, degradedChains],
  );

  if (staleLabels.length === 0 && degradedLabels.length === 0) return null;

  return (
    <>
      {staleLabels.length > 0 && (
        <div
          role="status"
          className="rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200/90"
        >
          <strong className="font-medium">Hero KPIs missing data.</strong>{" "}
          {staleLabels.join(", ")} {staleLabels.length === 1 ? "has" : "have"}{" "}
          had no swaps for ≥2 UTC days. Both the rolling-window snapshot and
          today&apos;s partial for{" "}
          {staleLabels.length === 1 ? "that chain" : "those chains"} are
          excluded from the totals below until the next swap fires the
          heartbeat.
        </div>
      )}
      {degradedLabels.length > 0 && (
        <div
          role="status"
          className="rounded-md border border-slate-600/50 bg-slate-800/40 px-3 py-2 text-[11px] text-slate-300/90"
        >
          <strong className="font-medium">
            Hero KPIs may be recent-incomplete.
          </strong>{" "}
          {degradedLabels.join(", ")}{" "}
          {degradedLabels.length === 1 ? "is" : "are"} in the canonical
          pre-first-swap-of-day state — yesterday&apos;s closed-day volume
          isn&apos;t in the snapshot yet and there&apos;s no today&apos;s
          partial. The snapshot&apos;s historical totals still contribute;
          they&apos;ll catch up as soon as the next swap fires the heartbeat.
        </div>
      )}
    </>
  );
}
