"use client";

import {
  isVirtualPool,
  type Pool,
  type PoolLiquidityStrategy,
  type PoolLiquidityStrategyKind,
  type RateFeed,
} from "@/lib/types";
import {
  getChainlinkDataFeedUrl,
  getRateFeedChainlinkDataFeedUrl,
  getRateFeedPair,
  getRateFeedReporterType,
} from "@mento-protocol/config/oracle-reporters";
import { isNeverRebalance } from "@/lib/health";
import { AddressLink } from "@/components/address-link";
import { Tooltip } from "@/components/tooltip";
import { Stat } from "@/components/stat";
import { HASURA_TIMEOUT_MS, useGQL } from "@/lib/graphql";
import {
  POOL_CONFIG_EXT,
  POOL_LIQUIDITY_STRATEGIES,
  POOL_RATE_FEED_EXT,
} from "@/lib/queries";
import {
  PoolConfigExtSchema,
  PoolLiquidityStrategiesSchema,
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
  const { data: strategiesExt } = usePoolLiquidityStrategies(pool, isVirtual);

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

  // Schema-lag and test fixtures can return a truthy GraphQL envelope without
  // the additive relation. Treat a missing field like an unavailable query and
  // keep the legacy pointer fallback until the promoted indexer exposes it.
  const strategies =
    strategiesExt?.PoolLiquidityStrategy ?? legacyPoolStrategies(pool);

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
      <Stat
        label={
          <span className="inline-flex items-center gap-1">
            Swap Fee
            <Tooltip
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
            <Tooltip
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
            <Tooltip
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
        value={<LiquidityStrategyList strategies={strategies} />}
      />
    </dl>
  );
}

function legacyPoolStrategies(pool: Pool): PoolLiquidityStrategy[] {
  if (!pool.rebalancerAddress) return [];
  return [
    {
      id: `${pool.id}-${pool.rebalancerAddress.toLowerCase()}`,
      chainId: pool.chainId,
      poolId: pool.id,
      strategyAddress: pool.rebalancerAddress,
      kind: "UNKNOWN",
      active: true,
      addedAtBlock: pool.createdAtBlock,
      addedAtTimestamp: pool.createdAtTimestamp,
      updatedAtBlock: pool.updatedAtBlock,
      updatedAtTimestamp: pool.updatedAtTimestamp,
    },
  ];
}

function strategyKindLabel(kind: PoolLiquidityStrategyKind): string {
  switch (kind) {
    case "OPEN":
      return "Open";
    case "CDP":
      return "CDP";
    case "RESERVE":
      return "Reserve";
    case "UNKNOWN":
      return "Strategy";
  }
}

function LiquidityStrategyList({
  strategies,
}: {
  strategies: readonly PoolLiquidityStrategy[];
}) {
  if (strategies.length === 0) {
    return <span className="text-slate-500">—</span>;
  }
  return (
    <span className="flex flex-col gap-1">
      {strategies.map((strategy) => (
        <span
          key={strategy.id}
          className="inline-flex items-center justify-end gap-1.5"
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {strategyKindLabel(strategy.kind)}
          </span>
          <AddressLink address={strategy.strategyAddress} readOnly />
        </span>
      ))}
    </span>
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
    return formatStaticOracleSource(pool, staticPair);
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
          ? getPoolChainlinkUrl(pool, pair)
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

function formatStaticOracleSource(pool: Pool, pair: string): OracleSource {
  const feedAddress = pool.referenceRateFeedID ?? "";
  const reporterType = feedAddress
    ? getRateFeedReporterType(pool.chainId, feedAddress)
    : null;
  const labelPrefix = reporterType
    ? formatReporterType(reporterType)
    : "SortedOracles";
  return {
    label: `${labelPrefix} ${pair}`,
    url: reporterType === "CHAINLINK" ? getPoolChainlinkUrl(pool, pair) : null,
  };
}

function getPoolChainlinkUrl(pool: Pool, pair: string): string | null {
  const feedAddress = pool.referenceRateFeedID;
  return feedAddress
    ? (getRateFeedChainlinkDataFeedUrl(pool.chainId, feedAddress) ??
        getChainlinkDataFeedUrl(pool.chainId, pair))
    : getChainlinkDataFeedUrl(pool.chainId, pair);
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

function usePoolLiquidityStrategies(pool: Pool, isVirtual: boolean) {
  return useGQL<{ PoolLiquidityStrategy: PoolLiquidityStrategy[] }>(
    isVirtual ? null : POOL_LIQUIDITY_STRATEGIES,
    { poolId: pool.id, chainId: pool.chainId },
    {
      timeoutMs: HASURA_TIMEOUT_MS,
      schema: PoolLiquidityStrategiesSchema,
    },
  );
}
