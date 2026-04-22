"use client";

import type {
  Pool,
  DeviationThresholdBreach,
  BreachEventCategory,
} from "@/lib/types";
import type { Network } from "@/lib/networks";
import { useGQL } from "@/lib/graphql";
import { POOL_DEVIATION_BREACHES } from "@/lib/queries";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { formatDurationShort } from "@/lib/bridge-status";
import {
  formatDeviationPct,
  DEVIATION_BREACH_GRACE_SECONDS,
} from "@/lib/health";
import { tradingSecondsInRange } from "@/lib/weekend";
import { explorerTxUrl } from "@/lib/tokens";
import { useAddressLabels } from "@/components/address-labels-provider";
import { BreachHistoryChart } from "@/components/breach-history-chart";

interface Props {
  pool: Pool;
  network: Network;
}

const END_REASON_LABELS: Record<BreachEventCategory, string> = {
  rebalance: "Rebalanced",
  swap: "Swap",
  liquidity: "Liquidity event",
  oracle_update: "Oracle moved",
  threshold_change: "Threshold changed",
  unknown: "Unknown",
};

const START_REASON_LABELS: Record<BreachEventCategory, string> = {
  rebalance: "Rebalance (reverse)",
  swap: "Swap",
  liquidity: "Liquidity event",
  oracle_update: "Oracle moved",
  threshold_change: "Threshold change",
  unknown: "Unknown",
};

/**
 * Historical deviation-breach view: scatter chart (frequency × duration) +
 * table (newest first, 100-row cap). Mounted as a tab on the pool page.
 * Renders null for virtual pools.
 */
export function BreachHistoryPanel({ pool, network }: Props) {
  const { getName } = useAddressLabels();
  const { data, isLoading, error } = useGQL<{
    DeviationThresholdBreach: DeviationThresholdBreach[];
  }>(pool.source.includes("virtual") ? null : POOL_DEVIATION_BREACHES, {
    poolId: pool.id,
  });

  if (pool.source.includes("virtual")) return null;

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
    // The new DeviationThresholdBreach entity is only present post-resync;
    // the hosted Hasura rejects the query with a schema-validation error
    // (containing "type not found" / "not found in type") until the new
    // indexer version syncs. That's a known-degraded state, not an
    // incident — surface it in the neutral empty-state style rather than
    // red, matching the UptimeValue tile's handling.
    const message = error instanceof Error ? error.message : String(error);
    const isSchemaLag =
      message.includes("not found in type") ||
      message.includes("type not found") ||
      message.includes("field 'DeviationThresholdBreach'");
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
        <h2 className="mb-4 text-sm text-slate-400">Breach History</h2>
        <p
          className={`text-sm ${isSchemaLag ? "text-slate-500" : "text-red-400"}`}
        >
          {isSchemaLag
            ? "Breach history not available yet — indexer rollout in progress."
            : "Couldn't load breach history — try again later."}
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
    <div className="flex flex-col gap-4">
      <BreachHistoryChart breaches={rows} pool={pool} />
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
    </div>
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
  const now = Math.floor(Date.now() / 1000);
  // Elapsed duration uses wall-clock for the "Duration" column on open
  // rows so the label moves in real time. Closed rows use the stored
  // trading-second value the indexer computed at close.
  const wallDuration = isOpen
    ? now - Number(breach.startedAt)
    : Number(breach.durationSeconds);
  // Past-grace ("critical") uses trading-seconds for open rows too, so
  // the unit matches the stored `criticalDurationSeconds` on closed rows
  // AND the uptime tile's live open-breach math. Without this, an open
  // breach spanning an FX weekend would briefly show an inflated "past
  // grace" that collapses once the indexer closes it.
  const graceEnd =
    Number(breach.startedAt) + Number(DEVIATION_BREACH_GRACE_SECONDS);
  const critDuration = isOpen
    ? now > graceEnd
      ? tradingSecondsInRange(graceEnd, now)
      : 0
    : Number(breach.criticalDurationSeconds);
  const threshold = pool.rebalanceThreshold ?? 0;
  const peakPct = threshold
    ? formatDeviationPct(breach.peakPriceDifference, threshold)
    : null;

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
      <td className="py-2 pr-4 whitespace-nowrap text-slate-400">
        {breach.rebalanceCountDuring}
      </td>
    </tr>
  );
}
