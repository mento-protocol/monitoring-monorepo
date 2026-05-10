"use client";

// Peak% and past-grace are ALWAYS scored against `entryRebalanceThreshold`
// (captured at the rising edge), never against live `pool.rebalanceThreshold`
// — pinned by the characterization tests; do not change.

import React from "react";
import type { DeviationThresholdBreach } from "@/lib/types";
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
  network,
  getName,
}: {
  breach: DeviationThresholdBreach;
  network: Network;
  getName: (addr: string | null, chainId?: number) => string;
}) {
  const isOpen = breach.endedAt == null;
  const now = Math.floor(Date.now() / 1000);
  // Trading-seconds on open rows (closed rows already had weekend closure
  // subtracted) so the Duration column doesn't shrink when an FX-weekend
  // open breach closes.
  const duration = isOpen
    ? tradingSecondsInRange(Number(breach.startedAt), now)
    : Number(breach.durationSeconds);
  // Only credit past-grace seconds once the peak crossed the 5% critical
  // line, scored against the entry threshold — mirrors the indexer's
  // closed-breach logic and the uptime tile.
  const graceEnd =
    Number(breach.startedAt) + Number(DEVIATION_BREACH_GRACE_SECONDS);
  // Pre-PR-1.6 legacy rows have `entryRebalanceThreshold=0` because the
  // prior indexer captured raw active threshold without the asymmetric-zero
  // substitute. Reading the live `pool.rebalanceThreshold` would consult
  // the post-flip side and re-score history (codex P2 PR #370 #3214748742,
  // mirrors the breach-history-chart fix). Canonicalize legacy 0 to 10000
  // directly — the predicate's under-bound for any pool that could have
  // legitimately captured 0.
  const entryThreshold =
    (breach.entryRebalanceThreshold ?? 0) > 0
      ? breach.entryRebalanceThreshold!
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
