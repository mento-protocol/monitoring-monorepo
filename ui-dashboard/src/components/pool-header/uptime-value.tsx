"use client";

import { isVirtualPool, type Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import { POOL_BREACH_ROLLUP } from "@/lib/queries";
import {
  computePoolUptimePct,
  computeWindowUptimePct,
  uptimeColorClass,
} from "@/lib/health";
import { isFxPool } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

const UPTIME_EXPLAINER =
  "% of time the oracle was fresh AND the pool's price stayed within the 1.01× tolerance of the rebalance threshold.\nStale oracle (no report past expiry) and price-deviation breaches both count as unhealthy.\n\n7d shows the same metric over the last 7 days, with a trend arrow vs all-time.";
const UPTIME_FX_SUFFIX = "\nWeekends don't count into FX pool uptime.";

const NA = <span className="text-slate-500">N/A</span>;
const SECONDS_IN_7D = 7 * 86_400;

type RollupRow = {
  healthBinarySeconds?: string;
  healthTotalSeconds?: string;
};
type DailyAnchorRow = {
  timestamp?: string;
  cumulativeHealthBinarySeconds?: string;
  cumulativeHealthTotalSeconds?: string;
};

export function UptimeValue({ pool }: { pool: Pool }) {
  const isVirtual = isVirtualPool(pool);
  // Bucket the 7d-anchor cutoff to UTC-day boundaries so the SWR cache
  // key only changes once per day — without this, every render produces
  // a fresh `sevenDaysAgo` (sub-second drift) that invalidates the cache.
  const todayStart = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
  const sevenDaysAgo = todayStart - SECONDS_IN_7D;

  const { data, error } = useGQL<{
    Pool: RollupRow[];
    PoolDailySnapshot: DailyAnchorRow[];
  }>(isVirtual ? null : POOL_BREACH_ROLLUP, {
    id: pool.id,
    chainId: pool.chainId,
    sevenDaysAgo,
  });

  if (isVirtual || error) return NA;
  const rollup = data?.Pool?.[0];
  if (!rollup) return NA;

  const pct = computePoolUptimePct({
    source: pool.source,
    healthBinarySeconds: rollup.healthBinarySeconds,
    healthTotalSeconds: rollup.healthTotalSeconds,
  });
  if (pct == null) return NA;

  const anchor = data?.PoolDailySnapshot?.[0] ?? null;
  const pct7d = computeWindowUptimePct(
    {
      healthBinarySeconds: rollup.healthBinarySeconds,
      healthTotalSeconds: rollup.healthTotalSeconds,
    },
    anchor,
  );

  // Trend arrow vs all-time. Gate on the .toFixed(2) values being
  // visibly different — anything finer would render an arrow for noise
  // the user can't see in the rounded numbers.
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
  // Screen readers stutter on literal newlines; the popover renders them
  // visually but the aria-label needs them collapsed.
  const ariaLabel = `About Uptime. ${content.replace(/\n/g, " ")}`;
  return <InfoPopover label={ariaLabel} content={content} />;
}
