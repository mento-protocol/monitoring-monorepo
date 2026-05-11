import { SECONDS_PER_DAY } from "@/lib/time-series";
import { networkForChainId } from "@/lib/networks";
import { weiToUsd } from "@/lib/format";

export type AggregatorDailyRow = {
  id: string;
  chainId: number;
  aggregator: string;
  lastSeenAggregatorAddress: string;
  timestamp: string;
  swapCount: number;
  swapCountIncludingSystem: number;
  uniqueTraders: number;
  uniqueTradersIncludingSystem: number;
  volumeUsdWei: string;
  volumeUsdWeiIncludingSystem: string;
};

export type AggregatorDailyRowBase = Pick<
  AggregatorDailyRow,
  | "chainId"
  | "aggregator"
  | "lastSeenAggregatorAddress"
  | "timestamp"
  | "swapCount"
  | "uniqueTraders"
  | "volumeUsdWei"
>;

export type AggregatorWindowRow = {
  chainId: number;
  aggregator: string;
  lastSeenAggregatorAddress: string;
  swapCount: number;
  uniqueTradersApprox: number;
  volumeUsdWei: bigint;
};

export type AggregatorBreakdown = {
  key: string;
  id: string;
  name: string;
  color: string;
  series: Array<{ timestamp: number; value: number }>;
};

const AGGREGATOR_PALETTE = [
  "#6366f1",
  "#22d3ee",
  "#f59e0b",
  "#ec4899",
  "#10b981",
  "#a855f7",
  "#f97316",
] as const;
const OTHER_COLOR = "#475569";
const TOP_N_AGGREGATORS = 7;
const OTHER_KEY = "__other__";
const ZERO = BigInt(0);

/**
 * Group `AggregatorDailySnapshot`-shaped rows by `(chainId, aggregator)`.
 * Volume and swap counts sum; unique traders is a lower bound using the
 * max single-day uniqueTraders count in the window.
 */
export function aggregateAggregatorsByWindow(
  rows: readonly AggregatorDailyRowBase[],
): AggregatorWindowRow[] {
  const byKey = new Map<string, AggregatorWindowRow>();
  const latestTsByKey = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.chainId}-${r.aggregator}`;
    const ts = Number(r.timestamp);
    const existing = byKey.get(key);
    if (existing) {
      existing.swapCount += r.swapCount;
      existing.volumeUsdWei += BigInt(r.volumeUsdWei);
      existing.uniqueTradersApprox = Math.max(
        existing.uniqueTradersApprox,
        r.uniqueTraders,
      );
      const prevLatest = latestTsByKey.get(key) ?? 0;
      if (ts > prevLatest) {
        existing.lastSeenAggregatorAddress = r.lastSeenAggregatorAddress;
        latestTsByKey.set(key, ts);
      }
    } else {
      byKey.set(key, {
        chainId: r.chainId,
        aggregator: r.aggregator,
        lastSeenAggregatorAddress: r.lastSeenAggregatorAddress,
        swapCount: r.swapCount,
        uniqueTradersApprox: r.uniqueTraders,
        volumeUsdWei: BigInt(r.volumeUsdWei),
      });
      latestTsByKey.set(key, ts);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (b.volumeUsdWei > a.volumeUsdWei) return 1;
    if (b.volumeUsdWei < a.volumeUsdWei) return -1;
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    return a.aggregator.localeCompare(b.aggregator);
  });
}

export function buildAggregatorDailyVolumeBreakdown(
  rows: readonly AggregatorDailyRowBase[],
  windowRange?: { fromSec: number; toSec: number },
): {
  totalSeries: Array<{ timestamp: number; value: number }>;
  breakdown: AggregatorBreakdown[];
} {
  if (rows.length === 0) {
    return { totalSeries: [], breakdown: [] };
  }

  const byAggregatorDay = new Map<string, bigint>();
  const totalsByAggregator = new Map<string, bigint>();
  const totalsByDay = new Map<number, bigint>();
  const days = new Set<number>();

  for (const r of rows) {
    const day = Number(r.timestamp);
    days.add(day);
    const wei = BigInt(r.volumeUsdWei);
    const key = `${r.chainId}-${r.aggregator}`;
    const dayKey = `${key}|${day}`;
    byAggregatorDay.set(dayKey, (byAggregatorDay.get(dayKey) ?? ZERO) + wei);
    totalsByAggregator.set(key, (totalsByAggregator.get(key) ?? ZERO) + wei);
    totalsByDay.set(day, (totalsByDay.get(day) ?? ZERO) + wei);
  }

  const sortedDays: number[] = [];
  if (windowRange) {
    for (
      let day = windowRange.fromSec;
      day <= windowRange.toSec;
      day += SECONDS_PER_DAY
    ) {
      sortedDays.push(day);
    }
  } else {
    sortedDays.push(...Array.from(days).sort((a, b) => a - b));
  }

  const ranked = Array.from(totalsByAggregator.entries()).sort(
    ([keyA, a], [keyB, b]) => {
      if (b > a) return 1;
      if (b < a) return -1;
      return keyA.localeCompare(keyB);
    },
  );
  const topKeys = ranked.slice(0, TOP_N_AGGREGATORS).map(([key]) => key);
  const otherKeys = new Set(
    ranked.slice(TOP_N_AGGREGATORS).map(([key]) => key),
  );

  const breakdown: AggregatorBreakdown[] = topKeys.map((key, idx) => ({
    key,
    id: key,
    name: aggregatorNameFromKey(key),
    color: AGGREGATOR_PALETTE[idx % AGGREGATOR_PALETTE.length]!,
    series: sortedDays.map((day) => ({
      timestamp: day,
      value: weiToUsd(byAggregatorDay.get(`${key}|${day}`) ?? ZERO),
    })),
  }));

  if (otherKeys.size > 0) {
    breakdown.push({
      key: OTHER_KEY,
      id: OTHER_KEY,
      name: `Other (${otherKeys.size})`,
      color: OTHER_COLOR,
      series: sortedDays.map((day) => {
        let total = ZERO;
        for (const key of otherKeys) {
          total += byAggregatorDay.get(`${key}|${day}`) ?? ZERO;
        }
        return { timestamp: day, value: weiToUsd(total) };
      }),
    });
  }

  return {
    totalSeries: sortedDays.map((day) => ({
      timestamp: day,
      value: weiToUsd(totalsByDay.get(day) ?? ZERO),
    })),
    breakdown,
  };
}

function aggregatorNameFromKey(key: string): string {
  const firstDash = key.indexOf("-");
  if (firstDash === -1) return key;
  const chainId = Number(key.slice(0, firstDash));
  const name = key.slice(firstDash + 1);
  const network = networkForChainId(chainId);
  return network ? `${name} (${network.label})` : name;
}
