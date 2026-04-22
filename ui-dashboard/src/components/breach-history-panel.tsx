"use client";

import type { Pool, DeviationThresholdBreach } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { useGQL } from "@/lib/graphql";
import { POOL_DEVIATION_BREACHES } from "@/lib/queries";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { formatDurationShort } from "@/lib/bridge-status";
import { explorerTxUrl } from "@/lib/tokens";
import { useAddressLabels } from "@/components/address-labels-provider";

interface Props {
  pool: Pool;
  network: Network;
}

const END_REASON_LABELS: Record<string, string> = {
  rebalance: "Rebalanced",
  swap: "Swap",
  liquidity: "Liquidity event",
  oracle_update: "Oracle moved",
  threshold_change: "Threshold changed",
  unknown: "Unknown",
};

const START_REASON_LABELS: Record<string, string> = {
  swap: "Swap",
  liquidity: "Liquidity event",
  oracle_update: "Oracle moved",
  rebalance: "Rebalance (reverse)",
  threshold_change: "Threshold change",
  unknown: "Unknown",
};

/**
 * Historical deviation-breach ledger. One row per breach (newest first), up
 * to the query's 100-row cap. Open breach appears at top with "ongoing"
 * duration. Skipped entirely for virtual pools or pools with no breaches.
 */
export function BreachHistoryPanel({ pool, network }: Props) {
  const { getName } = useAddressLabels();
  const { data, isLoading, error } = useGQL<{
    DeviationThresholdBreach: DeviationThresholdBreach[];
  }>(pool.source?.includes("virtual") ? null : POOL_DEVIATION_BREACHES, {
    poolId: pool.id,
  });

  if (pool.source?.includes("virtual")) return null;

  const rows = data?.DeviationThresholdBreach ?? [];
  if (isLoading && rows.length === 0) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
        <h2 className="mb-4 text-sm text-slate-400">Breach History</h2>
        <p className="text-sm text-slate-500">Loading…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
        <h2 className="mb-4 text-sm text-slate-400">Breach History</h2>
        <p className="text-sm text-red-400">
          Couldn't load breach history — try again later.
        </p>
      </section>
    );
  }
  if (rows.length === 0) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
        <h2 className="mb-4 text-sm text-slate-400">Breach History</h2>
        <p className="text-sm text-slate-500">
          No deviation-threshold breaches recorded for this pool.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm text-slate-400">Breach History</h2>
        <span className="text-xs text-slate-500">
          {rows.length >= 100 ? "100+ breaches" : `${rows.length} breaches`}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-2 pr-4 font-normal">Started</th>
              <th className="py-2 pr-4 font-normal">Duration</th>
              <th className="py-2 pr-4 font-normal">Past grace</th>
              <th className="py-2 pr-4 font-normal">Peak</th>
              <th className="py-2 pr-4 font-normal">Trigger</th>
              <th className="py-2 pr-4 font-normal">Ended by</th>
              <th className="py-2 pr-4 font-normal">Rebalances</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <BreachRow
                key={b.id}
                breach={b}
                pool={pool}
                network={network}
                getName={getName}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BreachRow({
  breach,
  pool,
  network,
  getName,
}: {
  breach: DeviationThresholdBreach;
  pool: Pool;
  network: Network;
  getName: (addr: string, chainId?: number) => string;
}) {
  const isOpen = breach.endedAt == null;
  // Open rows show the live "ongoing" duration against wall-clock, since the
  // indexer hasn't closed + weekend-subtracted the interval yet. Closed rows
  // use the stored trading-second duration.
  const now = Math.floor(Date.now() / 1000);
  const wallDuration = isOpen
    ? now - Number(breach.startedAt)
    : Number(breach.durationSeconds);
  const critDuration = isOpen
    ? Math.max(0, now - Number(breach.startedAt) - 3600)
    : Number(breach.criticalDurationSeconds);
  const threshold = pool.rebalanceThreshold ?? 10000;
  const peakPct = threshold
    ? ((Number(breach.peakPriceDifference) / threshold) * 100).toFixed(1)
    : "—";

  const endedLabel = isOpen
    ? "Ongoing"
    : (END_REASON_LABELS[breach.endedByEvent ?? ""] ?? "—");
  const startedLabel =
    START_REASON_LABELS[breach.startedByEvent] ?? breach.startedByEvent;

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
        {formatDurationShort(wallDuration)}
        {isOpen && <span className="ml-1 text-xs text-slate-500">ongoing</span>}
      </td>
      <td
        className={`py-2 pr-4 whitespace-nowrap ${critDuration > 0 ? "text-red-400" : "text-slate-500"}`}
      >
        {critDuration > 0 ? formatDurationShort(critDuration) : "—"}
      </td>
      <td
        className="py-2 pr-4 whitespace-nowrap"
        title={breach.peakPriceDifference}
      >
        {peakPct}%
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
      <td className="py-2 pr-4 whitespace-nowrap text-slate-400">
        {breach.rebalanceCountDuring}
      </td>
    </tr>
  );
}
