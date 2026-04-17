"use client";

import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { getOracleStalenessThreshold, isOracleFresh } from "@/lib/health";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { explorerTxUrl } from "@/lib/tokens";

export function OracleStatusValue({
  pool,
  network,
}: {
  pool: Pool;
  network: Network;
}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const hasTs = pool.oracleTimestamp != null && pool.oracleTimestamp !== "0";
  const stalenessThreshold = getOracleStalenessThreshold(pool, network.chainId);
  const fresh = isOracleFresh(pool, nowSeconds, network.chainId);
  const expiresLabel = `${Math.round(stalenessThreshold / 60)}m Expiry`;

  const updatedLabel = hasTs
    ? `Updated ${relativeTime(pool.oracleTimestamp!)}`
    : null;
  const updatedHref =
    hasTs && pool.oracleTxHash
      ? explorerTxUrl(network, pool.oracleTxHash)
      : null;

  const updatedTitle = hasTs
    ? formatTimestamp(pool.oracleTimestamp!)
    : undefined;

  return (
    <span className="flex flex-col gap-0.5">
      <span
        className={`flex items-center gap-1 font-medium ${fresh ? "text-emerald-400" : "text-red-400"}`}
      >
        <span>{fresh ? "✓ Fresh" : "✗ Stale"}</span>
        <span className="text-xs text-slate-600 font-normal" aria-hidden="true">
          ·
        </span>
        <span className="text-xs text-slate-600 font-normal">
          {expiresLabel}
        </span>
      </span>
      {updatedLabel &&
        (updatedHref ? (
          <a
            href={updatedHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-500 hover:text-indigo-400 transition-colors"
            title={updatedTitle}
          >
            {updatedLabel}
          </a>
        ) : (
          <span className="text-xs text-slate-500" title={updatedTitle}>
            {updatedLabel}
          </span>
        ))}
    </span>
  );
}
