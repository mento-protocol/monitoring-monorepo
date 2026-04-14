"use client";

import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { useAddressLabels } from "@/components/address-labels-provider";
import { useRebalanceCheck } from "@/hooks/use-rebalance-check";
import { strategyRebalanceWriteUrl } from "@/lib/rebalance-check";
import { formatTimestamp, relativeTime } from "@/lib/format";

export function RebalanceStatusValue({
  pool,
  network,
  strategyAddress,
}: {
  pool: Pool;
  network: Network;
  strategyAddress: string;
}) {
  const { getName } = useAddressLabels();
  const {
    data: rebalanceCheck,
    isLoading,
    error,
  } = useRebalanceCheck(pool, network);

  let statusText: string;
  let statusColor: string;
  let statusHref: string | null = null;

  if (isLoading) {
    statusText = "Checking…";
    statusColor = "text-slate-400";
  } else if (error) {
    // Transport/server errors (rate-limit propagation, 502, 503, 400 for
    // missing RPC, …) are NOT evidence the pool needs rebalancing — we just
    // couldn't diagnose. Surface a neutral state matching the HealthPanel's
    // "Diagnostics unavailable" copy and suppress the rebalance CTA.
    statusText = "Diagnostics unavailable";
    statusColor = "text-slate-400";
  } else if (rebalanceCheck === null) {
    statusText = "Balanced";
    statusColor = "text-emerald-400";
  } else if (rebalanceCheck.canRebalance) {
    statusText = "Rebalance required";
    statusColor = "text-amber-400";
    statusHref = strategyRebalanceWriteUrl(
      network.explorerBaseUrl,
      strategyAddress,
    );
  } else {
    statusText = "Rebalance blocked";
    statusColor = "text-red-400";
  }

  const strategyName = getName(strategyAddress);
  const strategyHref = `${network.explorerBaseUrl}/address/${strategyAddress}`;
  const hasLastRebalance =
    pool.lastRebalancedAt !== undefined && pool.lastRebalancedAt !== "0";
  const lastRebalanceLabel = hasLastRebalance
    ? `last ${relativeTime(pool.lastRebalancedAt!)}`
    : "never rebalanced";

  // Subtitle: "via <Strategy> · last Ns ago" — one line, primary ↗ stays on
  // the headline as the only CTA affordance; strategy link relies on the
  // indigo-hover color to signal clickability.
  return (
    <span className="flex flex-col gap-0.5">
      {statusHref ? (
        <a
          href={statusHref}
          target="_blank"
          rel="noopener noreferrer"
          className={`font-medium ${statusColor} hover:underline`}
        >
          {statusText} ↗
        </a>
      ) : (
        <span className={`font-medium ${statusColor}`}>{statusText}</span>
      )}
      <span
        className="text-xs text-slate-500"
        title={
          hasLastRebalance ? formatTimestamp(pool.lastRebalancedAt!) : undefined
        }
      >
        via{" "}
        <a
          href={strategyHref}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-indigo-400 transition-colors"
          title={strategyAddress}
        >
          {strategyName}
        </a>
        {" · "}
        {lastRebalanceLabel}
      </span>
    </span>
  );
}
