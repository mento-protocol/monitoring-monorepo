"use client";

import { isVirtualPool, type Pool } from "@/lib/types";
import { isNeverRebalance } from "@/lib/health";
import { AddressLink } from "@/components/address-link";
import { InfoPopover } from "@/components/info-popover";
import { Stat } from "@/components/stat";
import { HASURA_TIMEOUT_MS, useGQL } from "@/lib/graphql";
import { POOL_CONFIG_EXT } from "@/lib/queries";
import { PoolConfigExtSchema } from "@/lib/queries/pool-detail-schemas";
import { useNetwork } from "@/components/network-provider";
import { chainlinkFeed, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";

interface PoolConfigPanelProps {
  pool: Pool;
}

type PoolConfigExtRow = {
  rebalanceReward?: number;
};

// `-1` is the indexer's "RPC read failed, not yet self-healed" sentinel;
// `undefined` means the field hasn't reached hosted Hasura yet (phased
// rollout). Both render as em-dash so stale zeros aren't surfaced.
function formatBps(bps: number | null | undefined): string {
  if (bps == null || bps < 0) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

/** Static pool parameters row: swap fee, oracle/strategy provenance, and
 *  rebalance threshold/reward. Renders just the `<dl>` so callers (the
 *  pool header card) can stack it under the live KPI strip with a
 *  hairline divider. Hidden for virtual pools (no fees or rebalance
 *  mechanics). `rebalanceReward` is fetched via POOL_CONFIG_EXT so the
 *  page survives the indexer deploy+resync window. */
export function PoolConfigPanel({ pool }: PoolConfigPanelProps) {
  const { network } = useNetwork();
  const isVirtual = isVirtualPool(pool);
  const neverRebalances = isNeverRebalance(pool);
  const { data: configExt } = usePoolConfigExt(pool, isVirtual);

  if (isVirtual) return null;

  const rebalanceReward = configExt?.Pool?.[0]?.rebalanceReward;

  const lpFee = pool.lpFee;
  const protocolFee = pool.protocolFee;
  // Both legs must be valid before we sum: the indexer uses `-1` as the
  // "RPC read failed, not yet self-healed" sentinel for either fee, and
  // adding `-1` to a healed value would render a plausible-looking but
  // wrong total (e.g. `-1 + 100 → 0.99%`). Fall back to "—" instead.
  const swapFeeTotal =
    lpFee != null && lpFee >= 0 && protocolFee != null && protocolFee >= 0
      ? lpFee + protocolFee
      : null;

  // Prefer the non-USDm leg's feed and fall back to the USDm leg, so the
  // link points at the specific pair being oracled (USDC/USD on a USDC
  // pool, not generically USDm). Checking sym1 first picks the wrong leg
  // when USDm happens to be token1.
  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const nonUsdmSym = usdmIsToken0 ? sym1 : sym0;
  const usdmSym = usdmIsToken0 ? sym0 : sym1;
  const feed =
    chainlinkFeed(nonUsdmSym, network.chainId) ??
    chainlinkFeed(usdmSym, network.chainId);

  const strategyAddress = pool.rebalancerAddress ?? null;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Swap Fee
            <InfoPopover
              label="Swap Fee"
              content={`Total fee charged per swap\nSplit between LP fee (${formatBps(lpFee)}) and protocol fee (${formatBps(protocolFee)}).`}
            />
          </span>
        }
        value={formatBps(swapFeeTotal)}
        mono
      />
      <Stat
        label="Oracle Source"
        value={
          feed ? (
            <a
              href={feed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-300 hover:text-indigo-400 transition-colors"
            >
              Chainlink {feed.pair}
            </a>
          ) : (
            <span>SortedOracles</span>
          )
        }
      />
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Rebalance Threshold
            <InfoPopover
              label="Rebalance Threshold"
              content={
                neverRebalances
                  ? "Governance has disabled rebalancing for this pool. Deviation is still monitored, but no rebalance is permitted."
                  : "Internal pool price deviation from oracle price that must be exceeded before a rebalance is permitted on this pool."
              }
            />
          </span>
        }
        // Three states:
        // - never-rebalance (both split sides 0 + Known): "Never"
        // - threshold known (Known flag true): show the active value, even
        //   if it's `0` on the inactive side of an asymmetric pool
        //   (`above=0, below>0`) — that's a real configured value, not
        //   missing data, so it shouldn't render as "—".
        // - unknown (Known flag false): "—"
        value={
          neverRebalances
            ? "Never"
            : pool.rebalanceThresholdsKnown
              ? formatBps(pool.rebalanceThreshold ?? 0)
              : formatBps(null)
        }
        mono
      />
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Rebalance Reward
            <InfoPopover
              label="Rebalance Reward"
              content="Incentive (% of notional swap value) paid to the rebalancer that closes a deviation breach."
            />
          </span>
        }
        value={formatBps(rebalanceReward)}
        mono
      />
      <Stat
        label="Rebalance Strategy"
        value={
          strategyAddress ? (
            <AddressLink address={strategyAddress} readOnly />
          ) : (
            <span className="text-slate-500">—</span>
          )
        }
      />
    </dl>
  );
}

function usePoolConfigExt(pool: Pool, isVirtual: boolean) {
  return useGQL<{ Pool: PoolConfigExtRow[] }>(
    isVirtual ? null : POOL_CONFIG_EXT,
    { id: pool.id, chainId: pool.chainId },
    {
      timeoutMs: HASURA_TIMEOUT_MS,
      schema: PoolConfigExtSchema,
    },
  );
}
