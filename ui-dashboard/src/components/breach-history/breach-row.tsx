"use client";

/**
 * BreachRow renders a single row in the breach-history table. It owns the
 * row's domain math: trading-seconds via `tradingSecondsInRange` (so open
 * rows don't inflate on FX-pool weekends), grace-period end calculation, and
 * critical-ratio scoring. The peak% and past-grace duration are ALWAYS scored
 * against the row's `entryRebalanceThreshold` — the threshold captured at the
 * rising edge — never against the live mutable `pool.rebalanceThreshold`. This
 * invariant is pinned by the characterization test suite and must not change.
 */

import React from "react";
import type { DeviationThresholdBreach, Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { formatDurationShort } from "@/lib/bridge-status";
import {
  formatDeviationPct,
  DEVIATION_BREACH_GRACE_SECONDS,
  DEVIATION_CRITICAL_RATIO,
} from "@/lib/health";
import { tradingSecondsInRange } from "@/lib/weekend";
import { explorerTxUrl } from "@/lib/tokens";
import { END_REASON_LABELS, START_REASON_LABELS } from "./filters";

export function BreachRow({
  breach,
  pool,
  network,
  getName,
}: {
  breach: DeviationThresholdBreach;
  pool: Pool;
  network: Network;
  getName: (addr: string | null, chainId?: number) => string;
}) {
  const isOpen = breach.endedAt == null;
  const now = Math.floor(Date.now() / 1000);
  // Trading-seconds for both open and closed rows so the Duration column
  // doesn't shrink discontinuously when an FX-weekend-spanning open
  // breach closes (closed rows use the indexer's stored
  // `durationSeconds`, which is also trading-seconds with weekend
  // closure subtracted). Matches the unit used by the Past-grace column
  // and the Uptime tile.
  const duration = isOpen
    ? tradingSecondsInRange(Number(breach.startedAt), now)
    : Number(breach.durationSeconds);
  // Past-grace uses trading-seconds on open rows so the unit matches the
  // stored `criticalDurationSeconds` on closed rows and the uptime
  // tile's live math. Mirror of the closed-breach indexer logic AND the
  // uptime tile: only credit past-grace seconds when the breach's peak
  // crossed the 5% critical-magnitude line, scored against the threshold
  // captured at the rising edge.
  const graceEnd =
    Number(breach.startedAt) + Number(DEVIATION_BREACH_GRACE_SECONDS);
  // Fallback to current pool threshold during the indexer resync window
  // before `entryRebalanceThreshold` is backfilled. Once resync lands every
  // breach row carries its own entry threshold.
  const entryThreshold =
    (breach.entryRebalanceThreshold ?? 0) > 0
      ? breach.entryRebalanceThreshold!
      : (pool.rebalanceThreshold ?? 0) > 0
        ? pool.rebalanceThreshold!
        : 10000;
  const peakAboveCritical =
    Number(breach.peakPriceDifference) / entryThreshold >
    DEVIATION_CRITICAL_RATIO;
  const critDuration = isOpen
    ? peakAboveCritical && now > graceEnd
      ? tradingSecondsInRange(graceEnd, now)
      : 0
    : Number(breach.criticalDurationSeconds);
  // Peak % displayed in the row is scored against the SAME threshold the
  // severity bucket uses (entry threshold) so the percentage and the
  // critical-or-not verdict can't disagree across a mid-breach
  // FPMMRebalanceThresholdUpdated.
  const peakPct = formatDeviationPct(
    breach.peakPriceDifference,
    entryThreshold,
  );

  const endedLabel = isOpen
    ? "Ongoing"
    : END_REASON_LABELS[breach.endedByEvent ?? "unknown"];
  const startedLabel = START_REASON_LABELS[breach.startedByEvent];

  return (
    <tr className="border-t border-slate-800/60 text-slate-300">
      <td
        className="py-2 pr-4 whitespace-nowrap"
        title={formatTimestamp(breach.startedAt)}
      >
        <a
          href={explorerTxUrl(network, breach.startedByTxHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-indigo-400 transition-colors"
        >
          {relativeTime(breach.startedAt)}
        </a>
      </td>
      <td
        className={`py-2 pr-4 whitespace-nowrap ${isOpen ? "text-amber-400" : ""}`}
      >
        {formatDurationShort(duration)}
        {isOpen && <span className="ml-1 text-xs text-slate-500">ongoing</span>}
      </td>
      <td
        className={`py-2 pr-4 whitespace-nowrap ${critDuration > 0 ? "text-red-400" : "text-slate-500"}`}
      >
        {critDuration > 0 ? formatDurationShort(critDuration) : "—"}
      </td>
      <td
        className="py-2 pr-4 whitespace-nowrap text-right"
        title={breach.peakPriceDifference}
      >
        {peakPct ?? "—"}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap text-slate-400">
        {startedLabel}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap">
        {isOpen ? (
          <span className="text-slate-500">—</span>
        ) : breach.endedByTxHash ? (
          <a
            href={explorerTxUrl(network, breach.endedByTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-indigo-400 transition-colors"
            title={
              breach.endedByStrategy
                ? `via ${getName(breach.endedByStrategy, network.chainId)}`
                : undefined
            }
          >
            {endedLabel}
          </a>
        ) : (
          <span className="text-slate-400">{endedLabel}</span>
        )}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap text-right text-slate-400">
        {breach.rebalanceCountDuring}
      </td>
    </tr>
  );
}
