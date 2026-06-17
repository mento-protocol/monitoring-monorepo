import { SECONDS_PER_DAY } from "@/lib/time-series";
import type { CanonicalRevenueStream } from "./types";

export function currentDayBucket(nowSeconds: number): number {
  return dayBucket(Math.floor(nowSeconds));
}

export function dayBucket(timestampSeconds: number): number {
  return Math.floor(timestampSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

export function isoDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function streamKeyToNeedle(
  streamKey: CanonicalRevenueStream["key"],
): string {
  return streamKey === "cdp"
    ? "cdp"
    : streamKey === "swap"
      ? "swap"
      : "reserve";
}
