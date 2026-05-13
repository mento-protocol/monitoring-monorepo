"use client";

import { isVirtualPool, type Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import {
  POOL_BREACH_ROLLUP,
  POOL_HEALTH_7D_ANCHOR,
  POOL_HEALTH_CURSOR,
} from "@/lib/queries";
import {
  computePoolUptimePct,
  computeWindowUptimePct,
  liveHealthCounters,
  uptimeColorClass,
} from "@/lib/health";
import { isFxPool } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import { SECONDS_PER_DAY } from "@/lib/time-series";

const UPTIME_EXPLAINER =
  "% of time the oracle was fresh AND the pool's price stayed within the 1.01× tolerance of the rebalance threshold.\nStale oracle (no report past expiry) and price-deviation breaches both count as unhealthy.\n\n7d shows the same metric over the last 7 days, with a trend arrow vs all-time.";
const UPTIME_FX_SUFFIX = "\nWeekends don't count into FX pool uptime.";

const NA = <span className="text-slate-500">N/A</span>;

const ARROW = {
  up: {
    glyph: "↑",
    className: "text-emerald-400",
    aria: "trending up vs all-time",
  },
  down: {
    glyph: "↓",
    className: "text-red-400",
    aria: "trending down vs all-time",
  },
} as const;

type RollupRow = {
  healthBinarySeconds?: string;
  healthTotalSeconds?: string;
};
type HealthCursorRow = {
  lastOracleSnapshotTimestamp?: string;
  lastDeviationRatio?: string;
};
type DailyAnchorRow = {
  // Read by computeWindowUptimePct's freshness gate (rejects anchors >8d
  // old). If this field is ever dropped from POOL_HEALTH_7D_ANCHOR or
  // this type, the gate silently disables (anchorTs defaults to 0 →
  // "no freshness check") and stale anchors quietly broaden the window
  // past the "last 7d" label. Keep both in lockstep with the helper.
  timestamp?: string;
  cumulativeHealthBinarySeconds?: string;
  cumulativeHealthTotalSeconds?: string;
};

export function UptimeValue({ pool }: { pool: Pool }) {
  const isVirtual = isVirtualPool(pool);
  // Bucket the cutoff to UTC midnight so the SWR cache key only changes
  // once per day — sub-second drift would otherwise invalidate the cache
  // on every render.
  const todayStart =
    Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const sevenDaysAgo = todayStart - 7 * SECONDS_PER_DAY;

  // Fire the rollup (all-time) and the 7d-anchor as TWO separate queries.
  // If hosted Hasura rejects the new `cumulativeHealth*` fields during the
  // schema-rollout window, only the 7d subtitle degrades to "—"; the
  // all-time line stays rendered.
  const { data: rollupData, error: rollupError } = useGQL<{
    Pool: RollupRow[];
  }>(isVirtual ? null : POOL_BREACH_ROLLUP, {
    id: pool.id,
    chainId: pool.chainId,
  });
  const {
    data: cursorData,
    error: cursorError,
    isLoading: cursorLoading,
  } = useGQL<{ Pool: HealthCursorRow[] }>(
    isVirtual ? null : POOL_HEALTH_CURSOR,
    {
      id: pool.id,
      chainId: pool.chainId,
    },
  );
  const { data: anchorData } = useGQL<{ PoolDailySnapshot: DailyAnchorRow[] }>(
    isVirtual ? null : POOL_HEALTH_7D_ANCHOR,
    { id: pool.id, chainId: pool.chainId, sevenDaysAgo },
  );

  if (isVirtual || rollupError) return NA;
  const rollup = rollupData?.Pool?.[0];
  if (!rollup) return NA;
  if (!cursorError && cursorLoading && cursorData == null) return NA;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cursor = cursorData?.Pool?.[0];
  const livePool = { ...pool, ...rollup, ...(cursor ?? {}) };
  const anchor = anchorData?.PoolDailySnapshot?.[0] ?? null;
  const anchorTs = Number(anchor?.timestamp ?? "0");
  // All-time uptime uses the unclipped projection inside computePoolUptimePct;
  // the 7d subtitle clips the same open interval to the snapshot anchor first.
  const liveRollup = liveHealthCounters(
    livePool,
    nowSeconds,
    anchorTs > 0 ? anchorTs : undefined,
  );
  const pct = computePoolUptimePct(livePool, nowSeconds);
  if (pct == null) return NA;

  const pct7d = computeWindowUptimePct(liveRollup, anchor, nowSeconds);

  // Suppress the arrow when both values round to the same 2-decimal
  // string — anything finer would surface noise the user can't see.
  let trend: keyof typeof ARROW | null = null;
  if (pct7d != null && pct.toFixed(2) !== pct7d.toFixed(2)) {
    trend = pct7d > pct ? "up" : "down";
  }
  const arrow = trend ? ARROW[trend] : null;

  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">
        <span className={uptimeColorClass(pct)}>{pct.toFixed(2)}%</span>
        <span className="ml-1 text-xs text-slate-500">all-time</span>
      </span>
      <span className="text-xs text-slate-500">
        {pct7d != null ? (
          <>
            {arrow && (
              <span className={arrow.className} aria-label={arrow.aria}>
                {arrow.glyph}
              </span>
            )}
            {arrow && " "}
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
