"use client";

import type { Pool, RebalanceEvent } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { useAddressLabels } from "@/components/address-labels-provider";
import { useRebalanceCheck } from "@/hooks/use-rebalance-check";
import { computeHealthStatus } from "@/lib/health";
import type { RebalanceCheckResult } from "@/lib/rebalance-check";
import {
  isHealthyNoOp,
  strategyRebalanceWriteUrl,
} from "@/lib/rebalance-check";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { POOL_REBALANCES } from "@/lib/queries";
import { explorerTxUrl } from "@/lib/tokens";

/**
 * Compose the hover-tooltip for a genuinely blocked rebalance. Folds in the
 * decoded message, the raw error code, and any strategy enrichment (CDP
 * stability pool balance or reserve collateral) so the header cell carries
 * the detail previously shown in the standalone HealthPanel diagnostics.
 */
function buildBlockedTitle(result: RebalanceCheckResult): string {
  const parts: string[] = [];
  if (result.message) parts.push(result.message);
  if (result.rawError) parts.push(`[${result.rawError}]`);
  if (result.enrichment?.type === "cdp") {
    const balance = result.enrichment.stabilityPoolBalance;
    const formatted =
      balance >= 1000 ? `${(balance / 1000).toFixed(1)}k` : balance.toFixed(2);
    parts.push(
      `Stability pool: ${formatted} ${result.enrichment.stabilityPoolTokenSymbol}`,
    );
  } else if (result.enrichment?.type === "reserve") {
    const balance = result.enrichment.reserveCollateralBalance;
    const formatted =
      balance >= 1000 ? `${(balance / 1000).toFixed(1)}k` : balance.toFixed(2);
    parts.push(
      `Reserve collateral: ${formatted} ${result.enrichment.collateralTokenSymbol}`,
    );
  }
  return parts.join(" — ");
}

function getPassiveStatus(
  pool: Pool,
  network: Network,
): {
  text: string;
  color: string;
} {
  if (!network.rpcUrl) {
    return {
      text: "Diagnostics unavailable",
      color: "text-slate-400",
    };
  }

  const health = computeHealthStatus(pool, network.chainId);
  if (health === "OK") {
    return { text: "Balanced", color: "text-emerald-400" };
  }
  if (health === "WARN") {
    return { text: "Near threshold", color: "text-amber-400" };
  }
  if (health === "WEEKEND") {
    return { text: "Markets closed", color: "text-slate-400" };
  }
  if (health === "N/A") {
    return { text: "N/A", color: "text-slate-500" };
  }

  const diff = Number(pool.priceDifference ?? "0");
  const threshold =
    (pool.rebalanceThreshold ?? 0) > 0 ? pool.rebalanceThreshold! : 10000;

  if (diff < threshold) {
    return { text: "Oracle stale", color: "text-red-400" };
  }

  return {
    text: "Diagnostics unavailable",
    color: "text-slate-400",
  };
}

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
  let statusTitle: string | undefined;

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
    ({ text: statusText, color: statusColor } = getPassiveStatus(
      pool,
      network,
    ));
  } else if (rebalanceCheck.canRebalance) {
    statusText = "Rebalance required";
    statusColor = "text-amber-400";
    statusHref = strategyRebalanceWriteUrl(
      network.explorerBaseUrl,
      strategyAddress,
    );
  } else if (isHealthyNoOp(rebalanceCheck.rawError)) {
    // The strategy refused the rebalance because the pool is already
    // under its internal threshold — that's the healthy outcome, not an
    // alarm. Fall back to the passive signal so we don't render red
    // "Rebalance blocked" text at exactly-threshold deviation.
    ({ text: statusText, color: statusColor } = getPassiveStatus(
      pool,
      network,
    ));
  } else {
    statusText = "Rebalance blocked";
    statusColor = "text-red-400";
    statusTitle = buildBlockedTitle(rebalanceCheck);
  }

  const strategyName = getName(strategyAddress);
  const strategyHref = `${network.explorerBaseUrl}/address/${strategyAddress}`;
  // `!= null` catches both undefined AND null — the Pool type says
  // `string | undefined` but Hasura returns null for absent nullable
  // fields, and `null !== undefined` would otherwise slip past the gate,
  // rendering "last —" and firing an unnecessary POOL_REBALANCES query.
  const hasLastRebalance =
    pool.lastRebalancedAt != null && pool.lastRebalancedAt !== "0";
  const lastRebalanceLabel = hasLastRebalance
    ? `last ${relativeTime(pool.lastRebalancedAt!)}`
    : "never rebalanced";

  // Fetch the most recent rebalance tx so the "last Ns ago" label can link
  // to it on the explorer. Gated on hasLastRebalance to skip the query for
  // pools that have never rebalanced. `refreshInterval: 0` disables polling
  // — the latest-rebalance txHash rarely changes within a page session, and
  // when it does, a stale-but-valid explorer link is an acceptable tradeoff
  // for not issuing a background GQL read every 10s per open pool page.
  // (Different `limit` than the Rebalances tab means SWR can't dedupe them.)
  const { data: lastRebalanceData } = useGQL<{
    RebalanceEvent: Pick<RebalanceEvent, "txHash">[];
  }>(
    hasLastRebalance ? POOL_REBALANCES : null,
    hasLastRebalance ? { poolId: pool.id, limit: 1 } : undefined,
    0,
  );
  const lastRebalanceTxHash =
    lastRebalanceData?.RebalanceEvent?.[0]?.txHash ?? null;

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
          title={statusTitle}
          className={`font-medium ${statusColor} hover:underline`}
        >
          {statusText} ↗
        </a>
      ) : (
        <span className={`font-medium ${statusColor}`} title={statusTitle}>
          {statusText}
        </span>
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
        {hasLastRebalance && lastRebalanceTxHash ? (
          <a
            href={explorerTxUrl(network, lastRebalanceTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-indigo-400 transition-colors"
          >
            {lastRebalanceLabel}
          </a>
        ) : (
          lastRebalanceLabel
        )}
      </span>
    </span>
  );
}
