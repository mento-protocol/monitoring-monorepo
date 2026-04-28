"use client";

import { isVirtualPool, type Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import {
  POOL_BREACH_ROLLUP,
  POOL_CRITICAL_SECONDS_RECENT,
} from "@/lib/queries";
import {
  DEVIATION_BREACH_GRACE_SECONDS,
  DEVIATION_CRITICAL_RATIO,
  uptimeColorClass,
} from "@/lib/health";
import { tradingSecondsInRange } from "@/lib/weekend";
import { isFxPool } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

const UPTIME_EXPLAINER =
  "% of time the pool was healthy.\nUnhealthy is defined as Deviation > 5% threshold sustained for more than 1h.";
const UPTIME_FX_SUFFIX = "\nWeekends do not count into uptime on FX pools.";
const SECONDS_IN_7D = 7 * 86_400;

type BreachRollup = {
  cumulativeCriticalSeconds?: string;
  breachCount?: number;
  deviationBreachStartedAt?: string;
  currentOpenBreachPeak?: string;
  currentOpenBreachEntryThreshold?: number;
};

type RecentBreachRow = {
  criticalDurationSeconds?: string | number;
  startedAt?: string;
  endedAt?: string;
};

export function UptimeValue({ pool }: { pool: Pool }) {
  // Virtual pools have no oracle — page-level code already guards before
  // rendering this tile, but guard here too so a direct caller can't get
  // a misleading "100% — no breaches" on a pool that has no health data.
  const isVirtual = isVirtualPool(pool);
  const { data, error } = useGQL<{ Pool: BreachRollup[] }>(
    isVirtual ? null : POOL_BREACH_ROLLUP,
    { id: pool.id, chainId: pool.chainId },
  );
  // Window for the "% last 7d" subtitle. Bucket the start to the nearest
  // minute so the SWR cache key only changes once per minute — without
  // this, every render produces a fresh `windowStart` (sub-second drift)
  // that invalidates SWR's cache and re-fires the GraphQL request.
  const windowStart = Math.floor(Date.now() / 60_000) * 60 - SECONDS_IN_7D;
  const { data: recentData } = useGQL<{
    DeviationThresholdBreach: RecentBreachRow[];
  }>(isVirtual ? null : POOL_CRITICAL_SECONDS_RECENT, {
    poolId: pool.id,
    since: String(windowStart),
  });

  if (isVirtual) return <span className="text-slate-500">N/A</span>;

  const total = Number(pool.healthTotalSeconds ?? "0");
  if (!Number.isFinite(total) || total <= 0) {
    return <span className="text-slate-500">N/A</span>;
  }
  // During the indexer-resync window the hosted Hasura rejects the new
  // columns. N/A is the honest answer for "can't tell yet" — surfacing
  // "Query failed" would cry wolf.
  if (error) return <span className="text-slate-500">N/A</span>;

  // Gate on the rollup row being present. SWR returns `data: undefined`
  // during the initial fetch; without this guard the zero-defaults below
  // would render "100.000% — no breaches" as a flash of misleadingly
  // healthy content on every page load.
  const rollup = data?.Pool?.[0];
  if (!rollup) return <span className="text-slate-500">N/A</span>;

  // Read rollup + open-breach anchor from the SAME query result so they're
  // a consistent snapshot. Mixing with `pool.deviationBreachStartedAt`
  // from POOL_DETAIL_WITH_HEALTH would double-count a just-closed breach
  // during the brief window where the rollup refreshed first.
  const rolledCritical = Number(rollup.cumulativeCriticalSeconds ?? "0");
  const openStart = Number(rollup.deviationBreachStartedAt ?? "0");
  const hasOpenBreach = openStart > 0;

  // Open breaches aren't in `rolledCritical` until they close — add the
  // live past-grace portion so the tile moves in real time. Uses
  // `tradingSecondsInRange` (same weekend subtraction the indexer uses to
  // compute `healthTotalSeconds`) so the numerator and denominator are on
  // the same basis — a breach that spans a weekend doesn't get credited
  // seconds the denominator never saw. Mirror of the indexer's closed-
  // breach gate AND `computePoolUptimePct`: only count the live segment
  // when the breach's PEAK crossed the 5% critical-magnitude line, so the
  // tile and the persisted `cumulativeCriticalSeconds` use the same
  // peak-based view of severity (no jump on close).
  const nowSeconds = Math.floor(Date.now() / 1000);
  const graceEnd = openStart + Number(DEVIATION_BREACH_GRACE_SECONDS);
  const peak = Number(rollup.currentOpenBreachPeak ?? "0");
  // Prefer entry threshold (matches persisted accrual); fall back to the
  // pool's current threshold during the resync window before the new
  // column backfills.
  const thr =
    (rollup.currentOpenBreachEntryThreshold ?? 0) > 0
      ? rollup.currentOpenBreachEntryThreshold!
      : (pool.rebalanceThreshold ?? 0) > 0
        ? pool.rebalanceThreshold!
        : 10000;
  const peakAboveCritical = peak / thr > DEVIATION_CRITICAL_RATIO;
  const openCritical =
    hasOpenBreach && nowSeconds > graceEnd && peakAboveCritical
      ? tradingSecondsInRange(graceEnd, nowSeconds)
      : 0;

  const pct = Math.max(
    0,
    Math.min(100, (1 - (rolledCritical + openCritical) / total) * 100),
  );

  // 7-day uptime numerator: each closed breach's `criticalDurationSeconds`
  // is pro-rated by how much of the breach's wall-clock duration overlaps
  // the 7d window. Without the clip, a 5-day breach that ended just inside
  // the window would dump its full 5 days of critical seconds into a 7d
  // window where only a fraction of that breach actually fell — which can
  // push the numerator past the denominator and clamp the tile to 0% on
  // pools that are currently fine. Distribution-uniformity assumption is
  // imperfect (critical seconds aren't always evenly spread within a
  // breach) but bounds the error to that single breach. Open-breach
  // contribution is computed live, clamped to `windowStart`.
  const recentRows = recentData?.DeviationThresholdBreach;
  const closedCritical7d =
    recentRows?.reduce((sum, row) => {
      const critical = Number(row.criticalDurationSeconds ?? 0);
      const breachStart = Number(row.startedAt ?? "0");
      const breachEnd = Number(row.endedAt ?? "0");
      const totalDuration = breachEnd - breachStart;
      if (!Number.isFinite(critical) || critical <= 0 || totalDuration <= 0) {
        return sum;
      }
      const clipStart = Math.max(breachStart, windowStart);
      const clipEnd = Math.min(breachEnd, nowSeconds);
      const overlap = Math.max(0, clipEnd - clipStart);
      return sum + critical * (overlap / totalDuration);
    }, 0) ?? 0;
  const openCritical7d =
    hasOpenBreach && nowSeconds > graceEnd && peakAboveCritical
      ? tradingSecondsInRange(Math.max(graceEnd, windowStart), nowSeconds)
      : 0;
  const trading7d = tradingSecondsInRange(windowStart, nowSeconds);
  const have7d = recentRows !== undefined && trading7d > 0;
  const pct7d = have7d
    ? Math.max(
        0,
        Math.min(
          100,
          (1 - (closedCritical7d + openCritical7d) / trading7d) * 100,
        ),
      )
    : null;

  // Trend arrow vs all-time. Gate on the .toFixed(2) values being
  // visibly different — anything finer than 0.01% would render an arrow
  // for noise the user can't see in the rounded numbers.
  const trend: "up" | "down" | null =
    pct7d == null || pct.toFixed(2) === pct7d.toFixed(2)
      ? null
      : pct7d > pct
        ? "up"
        : "down";

  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">
        <span className={uptimeColorClass(pct)}>{pct.toFixed(2)}%</span>
        <span className="ml-1 text-xs text-slate-500">all-time</span>
      </span>
      <span className="text-xs text-slate-500">
        {pct7d != null ? (
          <>
            {trend === "up" && (
              <span
                className="text-emerald-400"
                aria-label="trending up vs all-time"
              >
                ↑
              </span>
            )}
            {trend === "down" && (
              <span
                className="text-red-400"
                aria-label="trending down vs all-time"
              >
                ↓
              </span>
            )}
            {trend && " "}
            {pct7d.toFixed(2)}% last 7d
          </>
        ) : (
          "—"
        )}
      </span>
    </span>
  );
}

export function UptimeInfoIcon({ pool }: { pool: Pool }) {
  const { network } = useNetwork();
  const suffix = isFxPool(network, pool.token0, pool.token1)
    ? UPTIME_FX_SUFFIX
    : "";
  const content = UPTIME_EXPLAINER + suffix;
  return <InfoPopover label={`About Uptime. ${content}`} content={content} />;
}
