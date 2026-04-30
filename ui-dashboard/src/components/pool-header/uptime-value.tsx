"use client";

import { isVirtualPool, type Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import { POOL_BREACH_ROLLUP } from "@/lib/queries";
import { uptimeColorClass } from "@/lib/health";
import { isFxPool } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

const UPTIME_EXPLAINER =
  "% of time the oracle was fresh AND price was within 1% of the rebalance threshold.\nStale oracle (no report past expiry) and price-deviation breaches both count as unhealthy.";
const UPTIME_FX_SUFFIX = "\nWeekends don't count into FX pool uptime.";

type BreachRollup = {
  healthBinarySeconds?: string;
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
  // during the initial fetch; without this guard a flash of misleading
  // "100%" content would render on every page load.
  const rollup = data?.Pool?.[0];
  if (!rollup) return <span className="text-slate-500">N/A</span>;

  const binary = Number(rollup.healthBinarySeconds ?? "0");
  if (!Number.isFinite(binary)) {
    return <span className="text-slate-500">N/A</span>;
  }

  const pct = Math.max(0, Math.min(100, (binary / total) * 100));

  return (
    <span className="font-medium">
      <span className={uptimeColorClass(pct)}>{pct.toFixed(2)}%</span>
      <span className="ml-1 text-xs text-slate-500">all-time</span>
    </span>
  );
}

export function UptimeInfoIcon({ pool }: { pool: Pool }) {
  const { network } = useNetwork();
  const suffix = isFxPool(network, pool.token0, pool.token1)
    ? UPTIME_FX_SUFFIX
    : "";
  const content = UPTIME_EXPLAINER + suffix;
  // aria-label has no notion of line breaks — collapse \n to a space so
  // screen readers read a single coherent sentence instead of a halting
  // pause some readers insert at literal newlines.
  const ariaLabel = `About Uptime. ${content.replace(/\n/g, " ")}`;
  return <InfoPopover label={ariaLabel} content={content} />;
}
