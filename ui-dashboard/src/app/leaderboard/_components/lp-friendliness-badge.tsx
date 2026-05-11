import type { LpFriendliness } from "@/lib/leaderboard-insights";

export function LpFriendlinessBadge({ value }: { value: LpFriendliness }) {
  const cls =
    value.band === "friendly"
      ? "bg-emerald-500/15 text-emerald-300"
      : value.band === "balanced"
        ? "bg-sky-500/15 text-sky-300"
        : "bg-amber-500/15 text-amber-300";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
      title={`${value.feeRateBps.toFixed(2)} bps fees · ${value.ratio.toFixed(4)} fee/pressure`}
      aria-label={`LP friendliness: ${value.score}/100, ${value.band}`}
    >
      {value.score}
    </span>
  );
}
