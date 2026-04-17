"use client";

import { useMemo } from "react";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { useAddressLabels } from "@/components/address-labels-provider";
import { InfoPopover } from "@/components/info-popover";
import { useRebalanceCheck } from "@/hooks/use-rebalance-check";
import { computeHealthStatus } from "@/lib/health";
import type { RebalanceCheckResult } from "@/lib/rebalance-check";
import {
  isHealthyNoOp,
  strategyRebalanceWriteUrl,
} from "@/lib/rebalance-check";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { LATEST_POOL_REBALANCE_FOR_STRATEGY } from "@/lib/queries";
import { explorerTxUrl } from "@/lib/tokens";

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
    // under its internal threshold — the live probe IS the authoritative
    // signal, so render a fixed "Balanced" label derived from it. Do NOT
    // recompute from indexed `pool` props: if the indexer hasn't caught up
    // post-rebalance, getPassiveStatus would surface a stale CRITICAL /
    // "Diagnostics unavailable" state over a clean live result.
    statusText = "Balanced";
    statusColor = "text-emerald-400";
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
  // rendering "last —" and firing an unnecessary lookup.
  const hasLastRebalance =
    pool.lastRebalancedAt != null && pool.lastRebalancedAt !== "0";
  const lastRebalanceLabel = hasLastRebalance
    ? `last ${relativeTime(pool.lastRebalancedAt!)}`
    : "never rebalanced";

  // Fetch the most recent rebalance tx for THIS strategy so the subtitle's
  // "last Ns ago" link attributes to the same strategy the cell names. An
  // unscoped lookup would wire the link to a tx emitted by a previously-
  // rotated strategy while the label still says "via <current strategy>".
  //
  // Lowercased address — Envio stores addresses lowercase. `refreshInterval:
  // 0` disables polling: the txHash rarely changes within a session, and
  // when it does, a stale-but-valid explorer link is an acceptable tradeoff
  // for not issuing a background GQL read every 10s per open pool page.
  // Memoize the variables object so its identity is stable across renders.
  const lastRebalanceVars = useMemo(
    () =>
      hasLastRebalance
        ? { poolId: pool.id, strategy: strategyAddress.toLowerCase() }
        : undefined,
    [hasLastRebalance, pool.id, strategyAddress],
  );
  const { data: lastRebalanceData } = useGQL<{
    RebalanceEvent: { txHash: string }[];
  }>(
    hasLastRebalance ? LATEST_POOL_REBALANCE_FOR_STRATEGY : null,
    lastRebalanceVars,
    0,
  );
  const lastRebalanceTxHash =
    lastRebalanceData?.RebalanceEvent?.[0]?.txHash ?? null;

  // Subtitle: "via <Strategy> · last Ns ago" — one line, primary ↗ stays on
  // the headline as the only CTA affordance; strategy link relies on the
  // indigo-hover color to signal clickability. The blocked-diagnostics ⓘ
  // button sits next to the headline — keyboard-focusable so the full
  // reason is reachable without hover.
  return (
    <span className="flex flex-col gap-0.5">
      <span className={`flex items-center gap-1 font-medium ${statusColor}`}>
        {statusHref ? (
          <a
            href={statusHref}
            target="_blank"
            rel="noopener noreferrer"
            title={statusTitle}
            className="hover:underline"
          >
            {statusText} ↗
          </a>
        ) : (
          <span>{statusText}</span>
        )}
        {statusTitle && !statusHref && (
          <RebalanceDiagnosticsInfoIcon title={statusTitle} />
        )}
      </span>
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

// Helpers

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
  // Passive status is derived entirely from indexed pool data — no RPC
  // required. Earlier versions gated this on `network.rpcUrl` and ended
  // up wiping "Balanced" / "Near threshold" / etc. for every healthy pool
  // on an RPC-less network. The rpcUrl gate lives only in the live-probe
  // path (useRebalanceCheck) where it belongs.
  const health = computeHealthStatus(pool, network.chainId);
  if (health === "OK") {
    return { text: "Balanced", color: "text-emerald-400" };
  }
  if (health === "WARN") {
    // Distinguish exactly-at-threshold from the 80–99% warning band so the
    // edge case reads as "At threshold" (not "Near threshold"), matching
    // the CRITICAL rule that kicks in only strictly above it. Use the same
    // 10000 bps fallback computeHealthStatus uses when rebalanceThreshold
    // is 0 — otherwise a pool at diff=10000, threshold=0 would render
    // "Near threshold" while the health pipeline treats it as the boundary.
    const diff = Number(pool.priceDifference ?? "0");
    const effectiveThreshold =
      (pool.rebalanceThreshold ?? 0) > 0 ? pool.rebalanceThreshold! : 10000;
    const atThreshold = diff === effectiveThreshold;
    return {
      text: atThreshold ? "At threshold" : "Near threshold",
      color: "text-amber-400",
    };
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

/**
 * Focusable ⓘ beside "Rebalance blocked" so the decoded failure reason
 * is reachable via keyboard / screen reader / touch. Click / Enter /
 * Space opens the explainer inline — no dead tab stop.
 */
function RebalanceDiagnosticsInfoIcon({ title }: { title: string }) {
  return (
    <InfoPopover label={`Rebalance diagnostics: ${title}`} content={title} />
  );
}
