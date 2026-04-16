/**
 * Fee time-series bucketing for the Revenue page.
 *
 * Converts raw ProtocolFeeTransfer rows into daily UTC buckets with USD
 * values, following the same bucketing pattern as buildDailyVolumeSeries.
 *
 * Protocol fees come from indexed ERC20 transfers to the yield split address.
 * LP fees are derived from protocol fees × (pool.lpFee / pool.protocolFee)
 * once the Pool entity carries those rate fields — until then lpFeesUSD is 0.
 */

import { parseWei } from "./format";
import { tokenToUSD } from "./tokens";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { TimeRange } from "./volume";

const SECONDS_PER_DAY = 86_400;

const UNRESOLVED_SYMBOLS = new Set(["UNKNOWN"]);

export type FeeSeriesPoint = {
  timestamp: number;
  protocolFeesUSD: number;
  lpFeesUSD: number;
};

/**
 * Build a daily-bucketed fee time series across all networks.
 *
 * Each ProtocolFeeTransfer is converted to USD and placed in a UTC-day
 * bucket. Missing days between the first and last transfer are gap-filled
 * with zeros.
 *
 * When `window` is provided, only transfers whose timestamp falls inside
 * the half-open `[window.from, window.to)` range are included.
 */
export function buildDailyFeeSeries(
  networkData: NetworkData[],
  window?: TimeRange,
): FeeSeriesPoint[] {
  const buckets = new Map<
    number,
    { protocolFeesUSD: number; lpFeesUSD: number }
  >();
  let minBucket = Infinity;

  for (const netData of networkData) {
    if (netData.error !== null) continue;

    for (const transfer of netData.feeTransfers) {
      if (UNRESOLVED_SYMBOLS.has(transfer.tokenSymbol)) continue;

      const ts = Number(transfer.blockTimestamp);
      if (window) {
        if (ts < window.from || ts >= window.to) continue;
      }

      const amount = parseWei(transfer.amount, transfer.tokenDecimals);
      const usd = tokenToUSD(transfer.tokenSymbol, amount, netData.rates);
      if (usd === null) continue;

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

  if (!Number.isFinite(minBucket)) return [];

  // Emit range: from the earliest bucket that has data (floor, not ceil) to
  // today. Using floor ensures a transfer at 12:00 on day D when window.from
  // is 10:00 on day D still appears — the bucket for day D contains only
  // in-window transfers because the filter above already excluded anything
  // before window.from.
  const startBucket = window
    ? Math.floor(window.from / SECONDS_PER_DAY) * SECONDS_PER_DAY
    : minBucket;
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
