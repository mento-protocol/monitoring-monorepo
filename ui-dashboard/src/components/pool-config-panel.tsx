"use client";

import { isVirtualPool, type Pool, type RateFeed } from "@/lib/types";
import {
  getChainlinkDataFeedUrl,
  getRateFeedPair,
} from "@mento-protocol/monitoring-config/oracle-reporters";
import { isNeverRebalance } from "@/lib/health";
import { AddressLink } from "@/components/address-link";
import { InfoPopover } from "@/components/info-popover";
import { Stat } from "@/components/stat";
import { HASURA_TIMEOUT_MS, useGQL } from "@/lib/graphql";
import { POOL_CONFIG_EXT, POOL_RATE_FEED_EXT } from "@/lib/queries";
import {
  PoolConfigExtSchema,
  PoolRateFeedExtSchema,
} from "@/lib/queries/pool-detail-schemas";

interface PoolConfigPanelProps {
  pool: Pool;
}

type PoolConfigExtRow = {
  rebalanceReward?: number | undefined;
};

type RateFeedExtRow = RateFeed;

type OracleSource = {
  label: string;
  url: string | null;
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
// eslint-disable-next-line complexity, max-lines-per-function -- Existing panel keeps schema-lag fallback and pool config rendering together.
export function PoolConfigPanel({ pool }: PoolConfigPanelProps) {
  const isVirtual = isVirtualPool(pool);
  const neverRebalances = isNeverRebalance(pool);
  const { data: configExt } = usePoolConfigExt(pool, isVirtual);
  const { data: rateFeedExt } = usePoolRateFeedExt(pool, isVirtual);

  if (isVirtual) return null;

  const rebalanceReward = configExt?.Pool?.[0]?.rebalanceReward;
  const oracleSource = formatOracleSource(rateFeedExt?.RateFeed?.[0], pool);

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
        value={<OracleSourceValue {...oracleSource} />}
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

function formatReporterType(type: RateFeed["reporterTypes"][number]): string {
  switch (type) {
    case "CHAINLINK":
      return "Chainlink";
    case "REDSTONE":
      return "Redstone";
    case "BRIDGED":
      return "Bridged";
    case "MANUAL":
      return "Manual";
  }
}

function OracleSourceValue({ label, url }: OracleSource) {
  if (!url) return <span>{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-indigo-300 transition-colors hover:text-indigo-200"
    >
      {label}
    </a>
  );
}

function formatOracleSource(
  rateFeed: RateFeedExtRow | undefined,
  pool: Pool,
): OracleSource {
  const feedAddress = pool.referenceRateFeedID ?? "";
  const staticPair = feedAddress
    ? getRateFeedPair(pool.chainId, feedAddress)
    : null;
  if (!rateFeed && staticPair) {
    return {
      label: `Chainlink ${staticPair}`,
      url: getChainlinkDataFeedUrl(pool.chainId, staticPair),
    };
  }
  if (!rateFeed) return { label: "SortedOracles", url: null };
  const pair =
    rateFeed.pair && rateFeed.pair !== "Unknown"
      ? rateFeed.pair
      : (staticPair ?? "");
  const uniqueTypes = Array.from(new Set(rateFeed.reporterTypes));
  if (uniqueTypes.length === 1 && uniqueTypes[0]) {
    const label = [formatReporterType(uniqueTypes[0]), pair]
      .filter(Boolean)
      .join(" ");
    return {
      label,
      url:
        uniqueTypes[0] === "CHAINLINK" && pair
          ? getChainlinkDataFeedUrl(pool.chainId, pair)
          : null,
    };
  }
  if (uniqueTypes.length > 1) {
    return { label: ["Mixed", pair].filter(Boolean).join(" "), url: null };
  }
  return {
    label: ["SortedOracles", pair].filter(Boolean).join(" "),
    url: null,
  };
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

function usePoolRateFeedExt(pool: Pool, isVirtual: boolean) {
  const feedAddress = pool.referenceRateFeedID?.toLowerCase();
  return useGQL<{ RateFeed: RateFeedExtRow[] }>(
    isVirtual || !feedAddress ? null : POOL_RATE_FEED_EXT,
    { chainId: pool.chainId, feedAddress },
    {
      timeoutMs: HASURA_TIMEOUT_MS,
      schema: PoolRateFeedExtSchema,
    },
  );
}
