"use client";

import type { Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { Stat } from "@/components/stat";
import { useGQL } from "@/lib/graphql";
import { POOL_CONFIG_EXT } from "@/lib/queries";

interface PoolConfigPanelProps {
  pool: Pool;
}

type PoolConfigExtRow = {
  rebalanceReward?: number;
};

// `-1` is the indexer's "RPC read failed, not yet self-healed" sentinel
// (see DEFAULT_ORACLE_FIELDS in indexer-envio/src/pool.ts). `undefined`
// means the field hasn't propagated through the hosted Hasura yet
// (phased schema rollout). Both render as em-dash so the user doesn't
// see "-0.01%" or stale zeros.
function formatBps(bps: number | null | undefined): string {
  if (bps == null || bps < 0) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Static pool parameters — fee split, rebalance threshold, and rebalance
 * reward. Lives between HealthPanel and the chart grid on the pool detail
 * page, matching the header metrics grid styling.
 *
 * Hidden entirely for virtual pools, which have no fees or rebalance
 * mechanics (mirrors `global-pools-table.tsx` virtual-pool filter).
 *
 * `rebalanceReward` ships in its own query (POOL_CONFIG_EXT) so the pool
 * page doesn't die during the indexer deploy+resync window — same pattern
 * as POOL_BREACH_ROLLUP. On error the reward tile falls back to "—".
 */
export function PoolConfigPanel({ pool }: PoolConfigPanelProps) {
  const isVirtual = pool.source?.includes("virtual");
  const { data: configExt } = useGQL<{ Pool: PoolConfigExtRow[] }>(
    isVirtual ? null : POOL_CONFIG_EXT,
    { id: pool.id, chainId: pool.chainId },
  );

  if (isVirtual) return null;

  const rebalanceReward = configExt?.Pool?.[0]?.rebalanceReward;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="text-base font-semibold text-white mb-4">Pool Config</h2>
      <dl className="flex flex-wrap gap-x-8 gap-y-4 text-sm">
        <Stat
          className="min-w-36"
          label={
            <span className="inline-flex items-center gap-1">
              LP Fee
              <InfoPopover
                label="LP Fee"
                content="Portion of each swap paid to liquidity providers, in basis points."
              />
            </span>
          }
          value={formatBps(pool.lpFee)}
          mono
        />
        <Stat
          className="min-w-36"
          label={
            <span className="inline-flex items-center gap-1">
              Protocol Fee
              <InfoPopover
                label="Protocol Fee"
                content="Portion of each swap routed to the protocol fee recipient, in basis points."
              />
            </span>
          }
          value={formatBps(pool.protocolFee)}
          mono
        />
        <Stat
          className="min-w-36"
          label={
            <span className="inline-flex items-center gap-1">
              Rebalance Threshold
              <InfoPopover
                label="Rebalance Threshold"
                content="Price deviation (bps) that must be exceeded before a rebalance is permitted on this pool."
              />
            </span>
          }
          // Indexer defaults rebalanceThreshold to 0 (not -1) and `health.ts`
          // treats 0 as "unknown, fall back to 10000" — rendering "0.00%"
          // would wrongly imply a 0-bps (always-breached) configuration.
          value={formatBps(pool.rebalanceThreshold || null)}
          mono
        />
        <Stat
          className="min-w-36"
          label={
            <span className="inline-flex items-center gap-1">
              Rebalance Reward
              <InfoPopover
                label="Rebalance Reward"
                content="Incentive (bps of swap notional) paid to the rebalancer that closes a deviation breach."
              />
            </span>
          }
          value={formatBps(rebalanceReward)}
          mono
        />
      </dl>
    </div>
  );
}
