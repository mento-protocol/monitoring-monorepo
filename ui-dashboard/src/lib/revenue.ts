/**
 * Daily fee time-series bucketing for the Revenue page.
 *
 * Reads `PoolDailyFeeSnapshot` rows (already day-bucketed by the indexer).
 * Hybrid USD pricing: pegged subtotal from `feesUsdWei`, FX from the
 * parallel `tokens[]` arrays via the live oracle rate map. Missing days
 * between the first and last bucket are gap-filled with zeros.
 *
 * LP fees are derived from protocol fees × (pool.lpFee / pool.protocolFee)
 * once the Pool entity carries those rate fields — until then `lpFeesUSD`
 * stays 0.
 */

import { parseWei } from "./format";
import { UNRESOLVED_SYMBOLS } from "./protocol-fees";
import { isUsdPegged, tokenToUSD } from "./tokens";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { TimeRange } from "./volume";

const SECONDS_PER_DAY = 86_400;

type FeeSeriesPoint = {
  timestamp: number;
  protocolFeesUSD: number;
  lpFeesUSD: number;
};

/**
 * Build a daily-bucketed fee time series across all networks.
 *
 * Each `PoolDailyFeeSnapshot` is keyed by UTC midnight already; we just
 * sum across pools per day. When `window` is provided, only buckets whose
 * `timestamp` falls inside the half-open `[window.from, window.to)` range
 * are included.
 */
/**
 * Snapshot timestamps are UTC-midnight buckets, but the input
 * `snapshotWindow7d/30d` carries hour-aligned bounds (`now - N*86400`).
 * Naively flooring `window.from` to midnight produces N+1 daily buckets
 * because half a day spills back across the day boundary — chart would
 * show 8 buckets while the KPI tile uses `dayStart - 6*86400` (7 buckets).
 * Match the tile's math: anchor on `dayStart(window.to) - (N-1)*86400`
 * so the chart and headline cover the same N daily buckets exactly.
 *
 * `Math.ceil` (not round): the window endpoints are usually hour-aligned,
 * so `[TODAY_MIDNIGHT - 3*86400, NOW]` spans ~3.x days, but the caller
 * wants 4 buckets. Also handles the sub-day case (`from = TODAY,
 * to = NOW` before noon UTC — `ceil(0.5) = 1`).
 *
 * The window is half-open `[from, to)`, so the last bucket in range is
 * `floor((to - 1) / 86400) * 86400` — using `to` directly would land on
 * the next midnight when `to` is at or past a day boundary.
 */
function dayAlignWindow(window: TimeRange): TimeRange {
  const days = Math.ceil((window.to - window.from) / SECONDS_PER_DAY);
  const lastBucketDayStart =
    Math.floor((window.to - 1) / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  return {
    from: lastBucketDayStart - (days - 1) * SECONDS_PER_DAY,
    to: window.to,
  };
}

function priceFeeSnapshotInUsd(
  s: NetworkData["feeSnapshots"][number],
  rates: NetworkData["rates"],
): number {
  let usd = Number(s.feesUsdWei) / 1e18;
  // FX side: price each non-pegged slot via the oracle rate map. Skip
  // pegged symbols (already counted in `feesUsdWei`) and indexer
  // placeholders.
  for (let i = 0; i < s.tokenSymbols.length; i++) {
    const sym = s.tokenSymbols[i];
    const rawAmount = s.amounts[i];
    const decimals = s.tokenDecimals[i];
    if (
      sym === undefined ||
      rawAmount === undefined ||
      decimals === undefined
    ) {
      continue;
    }
    if (UNRESOLVED_SYMBOLS.has(sym)) continue;
    if (isUsdPegged(sym)) continue;
    const amount = parseWei(rawAmount, decimals);
    const priced = tokenToUSD(sym, amount, rates);
    if (priced === null) continue;
    usd += priced;
  }
  return usd;
}

export function buildDailyFeeSeries(
  networkData: NetworkData[],
  window?: TimeRange,
): FeeSeriesPoint[] {
  const buckets = new Map<
    number,
    { protocolFeesUSD: number; lpFeesUSD: number }
  >();
  let minBucket = Infinity;
  const dayAlignedWindow = window ? dayAlignWindow(window) : undefined;

  function aggregateNetworkFees(netData: NetworkData): void {
    // Skip transport errors, `ratesError` (empty rate map silently drops
    // FX-token slots while pegged ones still price → trace would be subtly
    // wrong), and `feeSnapshotsError` (no row data to bucket).
    if (
      netData.error !== null ||
      netData.ratesError !== null ||
      netData.feeSnapshotsError !== null
    ) {
      return;
    }
    for (const s of netData.feeSnapshots) {
      const ts = Number(s.timestamp);
      if (
        dayAlignedWindow &&
        (ts < dayAlignedWindow.from || ts >= dayAlignedWindow.to)
      ) {
        continue;
      }
      const usd = priceFeeSnapshotInUsd(s, netData.rates);
      if (usd <= 0) continue;
      const bucket = Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      minBucket = Math.min(minBucket, bucket);
      const existing = buckets.get(bucket) ?? {
        protocolFeesUSD: 0,
        lpFeesUSD: 0,
      };
      existing.protocolFeesUSD += usd;
      // LP fee derivation: when Pool carries lpFee/protocolFee rate fields,
      // look up the source pool and derive lpFeeUSD = usd × (lpFee / protocolFee).
      // Until then, lpFeesUSD stays 0.
      buckets.set(bucket, existing);
    }
  }

  for (const netData of networkData) {
    aggregateNetworkFees(netData);
  }

  if (!Number.isFinite(minBucket)) return [];

  // Emit range: from the earliest bucket that has data (floor, not ceil) to
  // today. Using floor ensures a snapshot at 00:00 on day D when window.from
  // is inside D still appears — the bucket for day D contains only in-window
  // snapshots because the filter above already excluded anything before
  // window.from.
  const startBucket = dayAlignedWindow ? dayAlignedWindow.from : minBucket;
  const endRef = window?.to ?? Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(endRef / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;

  const series: FeeSeriesPoint[] = [];
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    const data = buckets.get(timestamp);
    series.push({
      timestamp,
      protocolFeesUSD: data?.protocolFeesUSD ?? 0,
      lpFeesUSD: data?.lpFeesUSD ?? 0,
    });
  }
  return series;
}
