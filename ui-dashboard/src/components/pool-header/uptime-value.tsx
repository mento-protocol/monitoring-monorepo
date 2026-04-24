"use client";

import { isVirtualPool, type Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import { POOL_BREACH_ROLLUP } from "@/lib/queries";
import { DEVIATION_BREACH_GRACE_SECONDS, uptimeColorClass } from "@/lib/health";
import { tradingSecondsInRange } from "@/lib/weekend";
import { isFxPool } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

const UPTIME_EXPLAINER =
  "% of time the pool was healthy. Deviation threshold breaches of more than 1h qualify as unhealthy.";
const UPTIME_FX_SUFFIX = " Weekends do not count into uptime on FX pools.";

type BreachRollup = {
  cumulativeCriticalSeconds?: string;
  breachCount?: number;
  deviationBreachStartedAt?: string;
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
  const closedBreachCount = rollup.breachCount ?? 0;
  const openStart = Number(rollup.deviationBreachStartedAt ?? "0");
  const hasOpenBreach = openStart > 0;

  // Open breaches aren't in `rolledCritical` until they close — add the
  // live past-grace portion so the tile moves in real time. Uses
  // `tradingSecondsInRange` (same weekend subtraction the indexer uses to
  // compute `healthTotalSeconds`) so the numerator and denominator are on
  // the same basis — a breach that spans a weekend doesn't get credited
  // seconds the denominator never saw.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const graceEnd = openStart + Number(DEVIATION_BREACH_GRACE_SECONDS);
  const openCritical =
    hasOpenBreach && nowSeconds > graceEnd
      ? tradingSecondsInRange(graceEnd, nowSeconds)
      : 0;

  const pct = Math.max(
    0,
    Math.min(100, (1 - (rolledCritical + openCritical) / total) * 100),
  );
  const totalBreaches = closedBreachCount + (hasOpenBreach ? 1 : 0);
  const subtitle =
    totalBreaches === 0
      ? "no breaches"
      : hasOpenBreach && closedBreachCount === 0
        ? "1 ongoing breach"
        : hasOpenBreach
          ? `${closedBreachCount} past + 1 ongoing`
          : `${closedBreachCount} ${closedBreachCount === 1 ? "breach" : "breaches"}`;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">
        <span className={uptimeColorClass(pct)}>{pct.toFixed(3)}%</span>
        <span className="ml-1 text-xs text-slate-500">all-time</span>
      </span>
      <span className="text-xs text-slate-500">{subtitle}</span>
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
