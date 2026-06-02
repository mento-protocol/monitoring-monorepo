import { bucketTimestamp } from "./time-series";

export type ChartGapFillPoint = {
  timestamp: number;
  value: number;
};

export type ChartGapFillRange = {
  from: number;
  to: number;
  bucketSeconds: number;
};

export type ForwardFilledPoint = {
  timestamp: number;
  value: number | undefined;
};

type BucketedObservation = ChartGapFillPoint & {
  bucket: number;
  index: number;
};

function firstBucketAtOrAfter(
  timestamp: number,
  bucketSeconds: number,
): number {
  return Math.ceil(timestamp / bucketSeconds) * bucketSeconds;
}

function sortedBucketedObservations(
  points: readonly ChartGapFillPoint[],
  bucketSeconds: number,
): BucketedObservation[] {
  return points
    .map((point, index) => ({
      ...point,
      bucket: bucketTimestamp(point.timestamp, bucketSeconds),
      index,
    }))
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp || a.bucket - b.bucket || a.index - b.index,
    );
}

function assertUsableRange(range: ChartGapFillRange): void {
  if (range.bucketSeconds <= 0) {
    throw new Error("bucketSeconds must be greater than zero");
  }
}

/**
 * Fills stock-like series (reserves, TVL, cumulative counters) across aligned
 * buckets. Each emitted bucket carries the most recent observed value at or
 * before that bucket, with `undefined` before the first observation.
 *
 * Callers own pre-bucket aggregation. If multiple points land in the same
 * bucket, this helper keeps the latest observation by timestamp.
 */
export function forwardFillSeries(
  points: readonly ChartGapFillPoint[],
  range: ChartGapFillRange,
): ForwardFilledPoint[] {
  assertUsableRange(range);
  if (range.to <= range.from) return [];

  const observations = sortedBucketedObservations(
    points,
    range.bucketSeconds,
  ).filter((point) => point.timestamp < range.to);
  const series: ForwardFilledPoint[] = [];
  const startBucket = firstBucketAtOrAfter(range.from, range.bucketSeconds);
  let observationIndex = 0;
  let currentValue: number | undefined;

  for (
    let timestamp = startBucket;
    timestamp < range.to;
    timestamp += range.bucketSeconds
  ) {
    while (
      observationIndex < observations.length &&
      observations[observationIndex]!.bucket <= timestamp
    ) {
      currentValue = observations[observationIndex]!.value;
      observationIndex += 1;
    }
    series.push({ timestamp, value: currentValue });
  }

  return series;
}

/**
 * Fills flow-like series (swap volume, counts, mints/burns) across aligned
 * buckets. Missing buckets become explicit zeroes so Plotly renders an honest
 * idle interval instead of silently skipping the day.
 *
 * Callers own pre-bucket aggregation. If multiple points land in the same
 * bucket, this helper keeps the latest observation by timestamp.
 */
export function zeroFillSeries(
  points: readonly ChartGapFillPoint[],
  range: ChartGapFillRange,
): ChartGapFillPoint[] {
  assertUsableRange(range);
  if (range.to <= range.from) return [];

  const startBucket = firstBucketAtOrAfter(range.from, range.bucketSeconds);
  const byBucket = new Map<number, number>();
  for (const point of sortedBucketedObservations(points, range.bucketSeconds)) {
    if (point.timestamp >= range.to) continue;
    if (point.bucket < startBucket || point.bucket >= range.to) continue;
    byBucket.set(point.bucket, point.value);
  }

  const series: ChartGapFillPoint[] = [];
  for (
    let timestamp = startBucket;
    timestamp < range.to;
    timestamp += range.bucketSeconds
  ) {
    series.push({ timestamp, value: byBucket.get(timestamp) ?? 0 });
  }

  return series;
}
