import {
  aggregateTraderPoolsByWindow,
  computeFlow,
  cmpBigInt,
  rangeDays,
  type LeaderboardRangeKey,
  type TraderPoolDailyRow,
  type TraderPoolWindowRow,
  type TraderWindowRow,
} from "@/lib/leaderboard";
import { SECONDS_PER_DAY } from "@/lib/time-series";

export type LpFriendlinessBand = "friendly" | "balanced" | "extractive";

export type LpFriendliness = {
  score: number;
  ratio: number;
  feeRateBps: number;
  imbalance: number;
  pressureUsdWei: bigint;
  band: LpFriendlinessBand;
};

export type TraderCohortSummary = {
  currentCount: number;
  previousCount: number;
  newCount: number;
  returningCount: number;
  dormantCount: number;
  topNewTrader: TraderWindowRow | null;
  topReturningTrader: TraderWindowRow | null;
  topDormantTrader: TraderWindowRow | null;
};

export type CorridorRow = {
  key: string;
  chainId: number;
  poolId: string;
  direction: 0 | 1;
  traderCount: number;
  swapCount: number;
  volumeUsdWei: bigint;
  netPressureUsdWei: bigint;
  feesPaidUsdWei: bigint;
  lpFriendliness: LpFriendliness;
};

export type SwapOutlierRow = {
  id: string;
  chainId: number;
  poolId: string;
  caller: string;
  txTo: string;
  recipient: string;
  volumeUsdWei: string;
  txHash: string;
  blockTimestamp: string;
};

type CorridorAccumulator = {
  chainId: number;
  poolId: string;
  direction: 0 | 1;
  traderKeys: Set<string>;
  swapCount: number;
  volumeUsdWei: bigint;
  inflowToken0UsdWei: bigint;
  outflowToken0UsdWei: bigint;
  inflowToken1UsdWei: bigint;
  outflowToken1UsdWei: bigint;
  feesPaidUsdWei: bigint;
};

const ZERO = BigInt(0);

export function traderIdentityKey(chainId: number, trader: string): string {
  return `${chainId}-${trader.toLowerCase()}`;
}

export function parseUsdWei(value: string): bigint | null {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const sign = match[1] === "-" ? -BigInt(1) : BigInt(1);
  const whole = BigInt(match[2]!);
  const fraction = match[3];
  const rounded =
    fraction && fraction[0] !== undefined && Number(fraction[0]) >= 5
      ? whole + BigInt(1)
      : whole;
  return sign * rounded;
}

export function previousLeaderboardWindowBounds(
  range: LeaderboardRangeKey,
  cutoff: number,
): { afterTimestamp: number; beforeTimestamp: number } | null {
  const days = rangeDays(range);
  if (days === null || cutoff <= 0) return null;
  const spanSeconds = days * SECONDS_PER_DAY;
  return {
    afterTimestamp: Math.max(0, cutoff - spanSeconds),
    beforeTimestamp: cutoff,
  };
}

export function computeLpFriendliness(
  pool: TraderPoolWindowRow,
): LpFriendliness {
  if (pool.volumeUsdWei <= ZERO) {
    return {
      score: 0,
      ratio: 0,
      feeRateBps: 0,
      imbalance: 0,
      pressureUsdWei: ZERO,
      band: "extractive",
    };
  }
  const flow = computeFlow(pool);
  const feeRateBps =
    Number((pool.feesPaidUsdWei * BigInt(1_000_000)) / pool.volumeUsdWei) / 100;
  const pressureUsdWei = netPressureUsdWei(pool);
  const denominator = pressureUsdWei > ZERO ? pressureUsdWei : BigInt(1);
  const ratio =
    Number((pool.feesPaidUsdWei * BigInt(1_000_000)) / denominator) / 1_000_000;
  const score = Math.max(0, Math.min(100, Math.round(ratio * 10_000)));
  return {
    score,
    ratio,
    feeRateBps,
    imbalance: flow.imbalance,
    pressureUsdWei,
    band: score >= 50 ? "friendly" : score >= 15 ? "balanced" : "extractive",
  };
}

export function buildTraderCohortSummary({
  current,
  previous,
}: {
  current: readonly TraderWindowRow[];
  previous: readonly TraderWindowRow[];
}): TraderCohortSummary {
  const currentByKey = new Map(
    current.map((r) => [traderIdentityKey(r.chainId, r.trader), r]),
  );
  const previousByKey = new Map(
    previous.map((r) => [traderIdentityKey(r.chainId, r.trader), r]),
  );
  const newTraders = current.filter(
    (r) => !previousByKey.has(traderIdentityKey(r.chainId, r.trader)),
  );
  const returningTraders = current.filter((r) =>
    previousByKey.has(traderIdentityKey(r.chainId, r.trader)),
  );
  const dormantTraders = previous.filter(
    (r) => !currentByKey.has(traderIdentityKey(r.chainId, r.trader)),
  );

  return {
    currentCount: current.length,
    previousCount: previous.length,
    newCount: newTraders.length,
    returningCount: returningTraders.length,
    dormantCount: dormantTraders.length,
    topNewTrader: newTraders[0] ?? null,
    topReturningTrader: returningTraders[0] ?? null,
    topDormantTrader: dormantTraders[0] ?? null,
  };
}

export function buildCorridorRows({
  rows,
  allowedTraderKeys,
  limit = 8,
}: {
  rows: readonly TraderPoolDailyRow[];
  allowedTraderKeys?: ReadonlySet<string>;
  limit?: number;
}): CorridorRow[] {
  const aggregated = aggregateTraderPoolsByWindow(
    allowedTraderKeys
      ? rows.filter((r) =>
          allowedTraderKeys.has(traderIdentityKey(r.chainId, r.trader)),
        )
      : rows,
  );
  const corridors = new Map<string, CorridorAccumulator>();
  for (const row of aggregated) {
    const flow = computeFlow(row);
    if (flow.direction === null) continue;
    const key = `${row.chainId}-${row.poolId.toLowerCase()}-${flow.direction}`;
    const existing = corridors.get(key);
    if (existing) {
      existing.traderKeys.add(traderIdentityKey(row.chainId, row.trader));
      existing.swapCount += row.swapCount;
      existing.volumeUsdWei += row.volumeUsdWei;
      existing.inflowToken0UsdWei += row.inflowToken0UsdWei;
      existing.outflowToken0UsdWei += row.outflowToken0UsdWei;
      existing.inflowToken1UsdWei += row.inflowToken1UsdWei;
      existing.outflowToken1UsdWei += row.outflowToken1UsdWei;
      existing.feesPaidUsdWei += row.feesPaidUsdWei;
    } else {
      corridors.set(key, {
        chainId: row.chainId,
        poolId: row.poolId,
        direction: flow.direction,
        traderKeys: new Set([traderIdentityKey(row.chainId, row.trader)]),
        swapCount: row.swapCount,
        volumeUsdWei: row.volumeUsdWei,
        inflowToken0UsdWei: row.inflowToken0UsdWei,
        outflowToken0UsdWei: row.outflowToken0UsdWei,
        inflowToken1UsdWei: row.inflowToken1UsdWei,
        outflowToken1UsdWei: row.outflowToken1UsdWei,
        feesPaidUsdWei: row.feesPaidUsdWei,
      });
    }
  }

  return Array.from(corridors.entries())
    .map(([key, c]) => {
      // `computeLpFriendliness` ignores the trader field; the sentinel keeps
      // the aggregated corridor shaped like a normal trader-pool window row.
      const poolLike: TraderPoolWindowRow = {
        chainId: c.chainId,
        trader: "__corridor__",
        poolId: c.poolId,
        swapCount: c.swapCount,
        volumeUsdWei: c.volumeUsdWei,
        inflowToken0UsdWei: c.inflowToken0UsdWei,
        outflowToken0UsdWei: c.outflowToken0UsdWei,
        inflowToken1UsdWei: c.inflowToken1UsdWei,
        outflowToken1UsdWei: c.outflowToken1UsdWei,
        feesPaidUsdWei: c.feesPaidUsdWei,
      };
      return {
        key,
        chainId: c.chainId,
        poolId: c.poolId,
        direction: c.direction,
        traderCount: c.traderKeys.size,
        swapCount: c.swapCount,
        volumeUsdWei: c.volumeUsdWei,
        netPressureUsdWei: netPressureUsdWei(poolLike),
        feesPaidUsdWei: c.feesPaidUsdWei,
        lpFriendliness: computeLpFriendliness(poolLike),
      };
    })
    .sort((a, b) => {
      const pressureCmp = cmpBigInt(a.netPressureUsdWei, b.netPressureUsdWei);
      if (pressureCmp !== 0) return -pressureCmp;
      if (a.chainId !== b.chainId) return a.chainId - b.chainId;
      if (a.poolId !== b.poolId) return a.poolId.localeCompare(b.poolId);
      return a.direction - b.direction;
    })
    .slice(0, limit);
}

export function filterSwapOutliers({
  rows,
  allowedTraderKeys,
  limit = 10,
}: {
  rows: readonly SwapOutlierRow[];
  allowedTraderKeys?: ReadonlySet<string>;
  limit?: number;
}): SwapOutlierRow[] {
  return (
    allowedTraderKeys
      ? rows.filter((r) =>
          allowedTraderKeys.has(traderIdentityKey(r.chainId, r.caller)),
        )
      : rows
  ).slice(0, limit);
}

function netPressureUsdWei(row: TraderPoolWindowRow): bigint {
  const net0 = abs(row.inflowToken0UsdWei - row.outflowToken0UsdWei);
  const net1 = abs(row.inflowToken1UsdWei - row.outflowToken1UsdWei);
  return (net0 + net1) / BigInt(2);
}

function abs(value: bigint): bigint {
  return value < ZERO ? -value : value;
}
