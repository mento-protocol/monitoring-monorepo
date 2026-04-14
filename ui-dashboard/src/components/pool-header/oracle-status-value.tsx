"use client";

// Header cells — current-state signals the top row surfaces at a glance.

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
  const oracleAge = hasTs ? nowSeconds - Number(pool.oracleTimestamp) : null;
  const stalenessThreshold = getOracleStalenessThreshold(pool, network.chainId);
  const fresh = isOracleFresh(pool, nowSeconds, network.chainId);

  return (
    <span className="flex flex-col gap-0.5">
      <span
        className={`font-medium ${fresh ? "text-emerald-400" : "text-red-400"}`}
      >
        {fresh ? "✓ Fresh" : "✗ Stale"}
      </span>
      {hasTs &&
        (pool.oracleTxHash ? (
          <a
            href={explorerTxUrl(network, pool.oracleTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-500 hover:text-indigo-400 transition-colors"
            title={formatTimestamp(pool.oracleTimestamp!)}
          >
            Updated {relativeTime(pool.oracleTimestamp!)} ↗
          </a>
        ) : (
          <span
            className="text-xs text-slate-500"
            title={formatTimestamp(pool.oracleTimestamp!)}
          >
            Updated {relativeTime(pool.oracleTimestamp!)}
          </span>
        ))}
      <span className="text-xs text-slate-500">
        Expires after {Math.round(stalenessThreshold / 60)}m
        {oracleAge != null && ` · ${oracleAge}s old`}
      </span>
    </span>
  );
}
