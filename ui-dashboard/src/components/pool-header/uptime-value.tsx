"use client";

import { isVirtualPool, type Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import { POOL_BREACH_ROLLUP } from "@/lib/queries";
import { computePoolUptimePct, uptimeColorClass } from "@/lib/health";
import { isFxPool } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

const UPTIME_EXPLAINER =
  "% of time the oracle was fresh AND price was within 1% of the rebalance threshold.\nStale oracle (no report past expiry) and price-deviation breaches both count as unhealthy.";
const UPTIME_FX_SUFFIX = "\nWeekends don't count into FX pool uptime.";

const NA = <span className="text-slate-500">N/A</span>;

type BreachRollup = { healthBinarySeconds?: string };

export function UptimeValue({ pool }: { pool: Pool }) {
  const isVirtual = isVirtualPool(pool);
  // Isolated rollup query so a hosted-Hasura schema lag during the
  // healthBinarySeconds rollout degrades just this tile to N/A instead
  // of breaking the whole pool page.
  const { data, error } = useGQL<{ Pool: BreachRollup[] }>(
    isVirtual ? null : POOL_BREACH_ROLLUP,
    { id: pool.id, chainId: pool.chainId },
  );

  if (isVirtual || error) return NA;
  const rollup = data?.Pool?.[0];
  if (!rollup) return NA;

  const pct = computePoolUptimePct({
    ...pool,
    healthBinarySeconds: rollup.healthBinarySeconds,
  });
  if (pct == null) return NA;

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
  // Screen readers stutter on literal newlines; the popover renders them
  // visually but the aria-label needs them collapsed.
  const ariaLabel = `About Uptime. ${content.replace(/\n/g, " ")}`;
  return <InfoPopover label={ariaLabel} content={content} />;
}
