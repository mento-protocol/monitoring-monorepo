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
  const stalenessThreshold = getOracleStalenessThreshold(pool, network.chainId);
  const fresh = isOracleFresh(pool, nowSeconds, network.chainId);
  const expiresLabel = `Expiry: ${Math.round(stalenessThreshold / 60)}m`;

  // Subtitle: "Updated Ns ago · expires 6m" — the first half links to the
  // oracle-report tx on the explorer when available; the "expires" half is
  // always plain text. Collapses the old three-line stack to two lines.
  const updatedLabel = hasTs
    ? `Updated ${relativeTime(pool.oracleTimestamp!)}`
    : null;
  const updatedHref =
    hasTs && pool.oracleTxHash
      ? explorerTxUrl(network, pool.oracleTxHash)
      : null;

  return (
    <span className="flex flex-col gap-0.5">
      <span
        className={`font-medium ${fresh ? "text-emerald-400" : "text-red-400"}`}
      >
        {fresh ? "✓ Fresh" : "✗ Stale"}
      </span>
      <span
        className="text-xs text-slate-500"
        title={hasTs ? formatTimestamp(pool.oracleTimestamp!) : undefined}
      >
        {updatedLabel &&
          (updatedHref ? (
            <a
              href={updatedHref}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-indigo-400 transition-colors"
            >
              {updatedLabel}
            </a>
          ) : (
            updatedLabel
          ))}
        {updatedLabel && " · "}
        {expiresLabel}
      </span>
    </span>
  );
}
