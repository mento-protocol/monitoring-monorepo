import { parseWei } from "@/lib/format";
import { SECONDS_PER_DAY, type TimeSeriesPoint } from "@/lib/time-series";
import { tokenToUSD, type OracleRateMap } from "@/lib/tokens";
import type { BridgeDailySnapshot } from "@/lib/types";

// Default decimals used when we have to convert `sentVolume` → tokens before
// applying a rate. The indexed stables all use 18dp; if a future bridged
// token doesn't, the UI underestimates USD rather than crashes — acceptable
// while USD pricing is deferred to the indexer (plan §1.5).
const DEFAULT_TOKEN_DECIMALS = 18;

/**
 * USD value of a single snapshot row. Prefers `sentUsdValue` when the
 * indexer has populated a real number; otherwise falls back to
 * `sentVolume × live oracle rate`. Returns 0 when the token can't be
 * priced (unknown symbol with no rate).
 *
 * Treats `"0.00"` as sentinel-null: legacy indexer rows pre-dating the
 * nullable USD schema wrote a `"0.00"` string on every row whether or
 * not the transfer actually had zero value. Accepting it as a truthy
 * USD reading would make every KPI $0 until the indexer redeploys.
 */
export function snapshotUsdValue(
  snapshot: Pick<
    BridgeDailySnapshot,
    "tokenSymbol" | "sentVolume" | "sentUsdValue"
  >,
  rates: OracleRateMap,
): number {
  if (snapshot.sentUsdValue) {
    const n = Number(snapshot.sentUsdValue);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const tokens = parseWei(snapshot.sentVolume, DEFAULT_TOKEN_DECIMALS);
  if (tokens === 0) return 0;
  return tokenToUSD(snapshot.tokenSymbol, tokens, rates) ?? 0;
}

/** Floor a unix-seconds timestamp to the UTC day start. */
function toDayBucket(timestampSeconds: number): number {
  return timestampSeconds - (timestampSeconds % SECONDS_PER_DAY);
}

/**
 * Sum per-day USD volume across the snapshot rows. Input may contain multiple
 * rows per day (one per provider × token × route); output has one point per
 * day, ascending by timestamp, with value = total USD sent that day.
 */
export function buildVolumeUsdSeries(
  snapshots: ReadonlyArray<BridgeDailySnapshot>,
  rates: OracleRateMap,
): TimeSeriesPoint[] {
  const byDay = new Map<number, number>();
  for (const s of snapshots) {
    const day = toDayBucket(Number(s.date));
    const usd = snapshotUsdValue(s, rates);
    byDay.set(day, (byDay.get(day) ?? 0) + usd);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestamp, value]) => ({ timestamp, value }));
}

/**
 * Same shape as `buildVolumeUsdSeries` but values are counts of transfers
 * sent that day. Useful when USD pricing is unreliable and we just want
 * "is the bridge being used more/less".
 */
export function buildCountSeries(
  snapshots: ReadonlyArray<BridgeDailySnapshot>,
): TimeSeriesPoint[] {
  const byDay = new Map<number, number>();
  for (const s of snapshots) {
    const day = toDayBucket(Number(s.date));
    byDay.set(day, (byDay.get(day) ?? 0) + (s.sentCount ?? 0));
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestamp, value]) => ({ timestamp, value }));
}

export type WindowTotals = {
  total: number | null;
  sub24h: number;
  sub7d: number;
  sub30d: number;
};

/**
 * Compute headline + 24h/7d/30d sub-totals from a snapshot list for a
 * scalar metric. `total` is `null` iff the list is empty (nothing to
 * show) — BreakdownTile renders that as N/A.
 */
export function windowTotals(
  snapshots: ReadonlyArray<BridgeDailySnapshot>,
  getValue: (s: BridgeDailySnapshot) => number,
  nowSeconds = Math.floor(Date.now() / 1000),
): WindowTotals {
  if (snapshots.length === 0) {
    return { total: null, sub24h: 0, sub7d: 0, sub30d: 0 };
  }
  const cutoff24h = nowSeconds - 1 * SECONDS_PER_DAY;
  const cutoff7d = nowSeconds - 7 * SECONDS_PER_DAY;
  const cutoff30d = nowSeconds - 30 * SECONDS_PER_DAY;
  let total = 0;
  let sub24h = 0;
  let sub7d = 0;
  let sub30d = 0;
  for (const s of snapshots) {
    const v = getValue(s);
    const ts = Number(s.date);
    total += v;
    if (ts >= cutoff24h) sub24h += v;
    if (ts >= cutoff7d) sub7d += v;
    if (ts >= cutoff30d) sub30d += v;
  }
  return { total, sub24h, sub7d, sub30d };
}

/** WoW delta on the summed series. Returns null when both weeks are empty. */
export function weekOverWeekChange(
  series: ReadonlyArray<TimeSeriesPoint>,
  nowSeconds = Math.floor(Date.now() / 1000),
): number | null {
  const weekAgo = nowSeconds - 7 * SECONDS_PER_DAY;
  const twoWeeksAgo = nowSeconds - 14 * SECONDS_PER_DAY;
  let thisWeek = 0;
  let lastWeek = 0;
  for (const p of series) {
    if (p.timestamp >= weekAgo) thisWeek += p.value;
    else if (p.timestamp >= twoWeeksAgo) lastWeek += p.value;
  }
  if (lastWeek === 0) {
    return thisWeek === 0 ? null : 100;
  }
  return ((thisWeek - lastWeek) / lastWeek) * 100;
}

export type TokenSlice = { symbol: string; usd: number };

/**
 * Sum per-token USD volume over a window (default: last 30 days).
 * Output sorted descending by USD. Empty tokens (0 USD) excluded.
 */
export function buildTokenBreakdown(
  snapshots: ReadonlyArray<BridgeDailySnapshot>,
  rates: OracleRateMap,
  windowDays = 30,
  nowSeconds = Math.floor(Date.now() / 1000),
): TokenSlice[] {
  const cutoff = nowSeconds - windowDays * SECONDS_PER_DAY;
  const byToken = new Map<string, number>();
  for (const s of snapshots) {
    if (Number(s.date) < cutoff) continue;
    const usd = snapshotUsdValue(s, rates);
    if (usd === 0) continue;
    byToken.set(s.tokenSymbol, (byToken.get(s.tokenSymbol) ?? 0) + usd);
  }
  return Array.from(byToken.entries())
    .map(([symbol, usd]) => ({ symbol, usd }))
    .sort((a, b) => b.usd - a.usd);
}
