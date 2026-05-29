import type { OraclePriceDailySnapshot } from "envio";
import { dayBucket, dailySnapshotId } from "../helpers.js";
import type { OracleRollupContext } from "./types.js";

// Fixidity 1e24 — oracle prices and breaker bands are 24-decimal fixed point.
const FIXIDITY_ONE = 10n ** 24n;

/**
 * Bigint mirror of `priceOutOfBand` in
 * `ui-dashboard/src/components/oracle-chart.tsx` (the chart's per-point
 * red/green verdict). Returns whether `price` falls outside its breaker band,
 * or `null` when no usable band exists (→ neutral, never red).
 *
 * Float source: `Math.abs(price - baseline) / baseline > thresholdRatio`, where
 * all three values are the Fixidity ints divided by 1e24. The 1e24 cancels in
 * `|p−b|/b`, leaving `|p−b|/b > t/1e24`, which cross-multiplies (baseline > 0)
 * to the exact, division-free integer form `|p−b| * 1e24 > t * baseline`.
 *
 * Guards mirror the float exactly:
 * - null / zero `baseline` or `threshold` → null. `fixidityToFloat("0")` is a
 *   finite `0`, and `priceOutOfBand` returns null on `baseline === 0` /
 *   `thresholdRatio === 0` (both would render every marker red).
 * - `price === 0n` → null. The chart maps `oraclePrice === "0"` to `NaN`
 *   upstream in `snapshotIsRed`, and `priceOutOfBand` returns null on a
 *   non-finite price.
 */
export const sampleOutOfBand = (
  price: bigint | undefined,
  baseline: bigint | undefined,
  threshold: bigint | undefined,
): boolean | null => {
  if (
    price == null ||
    price === 0n ||
    baseline == null ||
    baseline === 0n ||
    threshold == null ||
    threshold === 0n
  ) {
    return null;
  }
  const diff = price > baseline ? price - baseline : baseline - price;
  return diff * FIXIDITY_ONE > threshold * baseline;
};

/**
 * Numeric max of two fixed-point decimal strings. `deviationRatio` is a 6dp
 * string, so lexical comparison is wrong (`"9.500000" > "10.000000"`). Parse
 * to Number for the magnitude compare; return the original string so the stored
 * value keeps its exact 6dp form.
 */
const maxNumericString = (a: string, b: string): string =>
  Number(b) > Number(a) ? b : a;

/**
 * Upsert the daily oracle-price OHLC candle. Mirrors `upsertDailySnapshot`'s
 * read-merge-write shape, but tracks open/high/low/close, an out-of-band OR
 * fold, and a numeric max of `deviationRatio`. Hooked only in the MedianUpdated
 * handler, after the OracleSnapshot is written. Exported for tests.
 */
export const upsertOraclePriceDaily = async ({
  context,
  chainId,
  poolId,
  blockTimestamp,
  blockNumber,
  oraclePrice,
  oracleOk,
  deviationRatio,
  breakerBaselineAtSnapshot,
  breakerThresholdAtSnapshot,
}: {
  context: OracleRollupContext;
  chainId: number;
  poolId: string;
  blockTimestamp: bigint;
  blockNumber: bigint;
  oraclePrice: bigint;
  oracleOk: boolean;
  deviationRatio: string;
  breakerBaselineAtSnapshot: bigint | undefined;
  breakerThresholdAtSnapshot: bigint | undefined;
}): Promise<void> => {
  // A zero median price is an oracle outage (all reporters expired). The raw
  // chart maps `oraclePrice === "0"` → NaN → not plotted, so a zero sample must
  // not fold into the candle either — otherwise open/low/close would be dragged
  // to 0 (a wick to the chart floor + a close=0 that corrupts the daily→raw
  // handoff). Skip it entirely, mirroring the chart's gap. (`oracleOk` is always
  // true at the only write site, so there's no rejected-report red to lose here;
  // if a caller ever passes `oracleOk: false` with a zero price, revisit.)
  if (oraclePrice === 0n) return;

  const bucketStart = dayBucket(blockTimestamp);
  const id = dailySnapshotId(poolId, bucketStart);
  const existing = await context.OraclePriceDailySnapshot.get(id);

  // Per-sample chart-red verdict = OR of the two conditions `snapshotIsRed`
  // uses: a rejected report (`!oracleOk`) OR a price outside its band. The
  // `!oracleOk` term is moot today (the MedianUpdated handler hardcodes
  // `oracleOk: true`), but OR-ing it keeps this definitionally "OR of
  // snapshotIsRed" rather than correct-only-while-that-hardcode-holds.
  const sampleRed =
    !oracleOk ||
    sampleOutOfBand(
      oraclePrice,
      breakerBaselineAtSnapshot,
      breakerThresholdAtSnapshot,
    ) === true;

  const snapshot: OraclePriceDailySnapshot = existing
    ? {
        ...existing,
        highPrice:
          oraclePrice > existing.highPrice ? oraclePrice : existing.highPrice,
        lowPrice:
          oraclePrice < existing.lowPrice ? oraclePrice : existing.lowPrice,
        closePrice: oraclePrice,
        sampleCount: existing.sampleCount + 1,
        anyOutOfBand: existing.anyOutOfBand || sampleRed,
        maxDeviationRatio: maxNumericString(
          existing.maxDeviationRatio,
          deviationRatio,
        ),
        // End-of-day band = last median's band; overwrite on every sample.
        endBreakerBaselineAtSnapshot: breakerBaselineAtSnapshot,
        endBreakerThresholdAtSnapshot: breakerThresholdAtSnapshot,
        blockNumber,
      }
    : {
        id,
        chainId,
        poolId,
        bucketStart,
        openPrice: oraclePrice,
        highPrice: oraclePrice,
        lowPrice: oraclePrice,
        closePrice: oraclePrice,
        sampleCount: 1,
        anyOutOfBand: sampleRed,
        maxDeviationRatio: deviationRatio,
        endBreakerBaselineAtSnapshot: breakerBaselineAtSnapshot,
        endBreakerThresholdAtSnapshot: breakerThresholdAtSnapshot,
        blockNumber,
      };

  context.OraclePriceDailySnapshot.set(snapshot);
};
