import { tokenToUSD, type OracleRateMap } from "./tokens";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import type { TimeRange } from "./volume";
import type { CdpBorrowingRevenueBracket } from "./cdp-borrowing-revenue";

export const ZERO = BigInt(0);
export const D18 = BigInt(10) ** BigInt(18);
const ONE_YEAR_SECONDS = BigInt(31_536_000);

export type BorrowingFeeBucket = {
  upfrontFeesUSD: number;
  accruedInterestUSD: number;
};

export type BorrowingFeeBucketContext = {
  buckets: Map<number, BorrowingFeeBucket>;
  rates: OracleRateMap;
  unpricedSymbols: Set<string>;
};

export function accruedInterestWei(
  bracket: Pick<
    CdpBorrowingRevenueBracket,
    "pendingDebtTimesOneYearD36" | "sumDebtTimesRateD36" | "updatedAt"
  >,
  nowSeconds: number,
): bigint {
  const pendingDebtTimesOneYearD36 = BigInt(bracket.pendingDebtTimesOneYearD36);
  const sumDebtTimesRateD36 = BigInt(bracket.sumDebtTimesRateD36);
  const updatedAt = BigInt(bracket.updatedAt);
  const now = BigInt(Math.max(0, Math.floor(nowSeconds)));
  const elapsed = now > updatedAt ? now - updatedAt : ZERO;
  return (
    (pendingDebtTimesOneYearD36 + sumDebtTimesRateD36 * elapsed) /
    ONE_YEAR_SECONDS /
    D18
  );
}

export function pendingAccruedInterestWei(
  bracket: Pick<CdpBorrowingRevenueBracket, "pendingDebtTimesOneYearD36">,
): bigint {
  return BigInt(bracket.pendingDebtTimesOneYearD36) / ONE_YEAR_SECONDS / D18;
}

export function liveAccruedInterestWei(
  bracket: Pick<CdpBorrowingRevenueBracket, "sumDebtTimesRateD36">,
  elapsedSeconds: number,
): bigint {
  if (elapsedSeconds <= 0) return ZERO;
  return (
    (BigInt(bracket.sumDebtTimesRateD36) * BigInt(elapsedSeconds)) /
    ONE_YEAR_SECONDS /
    D18
  );
}

export function dayBucket(timestampSeconds: number): number {
  return Math.floor(timestampSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

export function dayAlignWindow(window: TimeRange): TimeRange {
  const days = Math.ceil((window.to - window.from) / SECONDS_PER_DAY);
  const lastBucketDayStart = dayBucket(window.to - 1);
  return {
    from: lastBucketDayStart - (days - 1) * SECONDS_PER_DAY,
    to: window.to,
  };
}

function weiToTokenAmount(wei: bigint): number {
  // Split before Number() so large cumulative wei values keep token-scale precision.
  const whole = wei / D18;
  const fractional = wei % D18;
  return Number(whole) + Number(fractional) / 1e18;
}

function weiToTokenUSD(
  symbol: string,
  wei: bigint,
  rates: OracleRateMap,
): number | null {
  if (wei <= ZERO) return 0;
  return tokenToUSD(symbol, weiToTokenAmount(wei), rates);
}

export function addPricedWei(
  symbol: string | undefined,
  wei: bigint,
  rates: OracleRateMap,
  unpricedSymbols: Set<string>,
): number {
  if (wei <= ZERO) return 0;
  if (symbol === undefined) {
    unpricedSymbols.add("UNKNOWN");
    return 0;
  }
  const usd = weiToTokenUSD(symbol, wei, rates);
  if (usd === null) {
    unpricedSymbols.add(symbol);
    return 0;
  }
  return usd;
}

function addBorrowingFeeUsd(
  buckets: Map<number, BorrowingFeeBucket>,
  timestamp: number,
  kind: "upfront" | "interest",
  usd: number,
): void {
  if (usd <= 0) return;
  const bucketTimestamp = dayBucket(timestamp);
  const bucket = buckets.get(bucketTimestamp) ?? {
    upfrontFeesUSD: 0,
    accruedInterestUSD: 0,
  };
  if (kind === "upfront") {
    bucket.upfrontFeesUSD += usd;
  } else {
    bucket.accruedInterestUSD += usd;
  }
  buckets.set(bucketTimestamp, bucket);
}

export function addBorrowingFeeWei(
  context: BorrowingFeeBucketContext,
  input: {
    symbol: string | undefined;
    timestamp: number;
    kind: "upfront" | "interest";
    wei: bigint;
  },
): void {
  addBorrowingFeeUsd(
    context.buckets,
    input.timestamp,
    input.kind,
    addPricedWei(
      input.symbol,
      input.wei,
      context.rates,
      context.unpricedSymbols,
    ),
  );
}

export function bucketHasValue(
  bucket: BorrowingFeeBucket | undefined,
): boolean {
  return (
    bucket !== undefined &&
    (bucket.upfrontFeesUSD > 0 || bucket.accruedInterestUSD > 0)
  );
}

export function isBucketInWindow(
  timestamp: number,
  dayAlignedWindow: TimeRange | undefined,
): boolean {
  if (!dayAlignedWindow) return true;
  const bucketTimestamp = dayBucket(timestamp);
  return (
    bucketTimestamp >= dayAlignedWindow.from &&
    bucketTimestamp < dayAlignedWindow.to
  );
}
