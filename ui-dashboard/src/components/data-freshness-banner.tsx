"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getSWRFreshnessStatus,
  getSWRFreshnessVersion,
  subscribeSWRFreshness,
} from "@/lib/swr-freshness";

const TICK_MS = 10_000;

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export function DataFreshnessBanner() {
  useSyncExternalStore(
    subscribeSWRFreshness,
    getSWRFreshnessVersion,
    getSWRFreshnessVersion,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const currentNow = Math.max(now, Date.now());
  const status = getSWRFreshnessStatus();
  if (status === null) return null;

  const cachedAge =
    status.cachedLastUpdatedAt === null
      ? null
      : formatAge(currentNow - status.cachedLastUpdatedAt);
  const failedAge =
    status.failedLastUpdatedAt === null
      ? null
      : formatAge(currentNow - status.failedLastUpdatedAt);
  const failedSourceCount =
    status.failedCount === 1
      ? "1 data source"
      : `${status.failedCount} data sources`;
  const cachedSourceCount =
    status.cachedCount === 1
      ? "1 data source"
      : `${status.cachedCount} data sources`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-amber-400/20 bg-amber-950/30 px-3 py-2 text-xs text-amber-100 sm:px-6"
    >
      <div className="mx-auto max-w-7xl">
        {status.failedCount > 0 && failedAge !== null ? (
          <>
            Latest refresh failed. Showing last-good data from {failedAge} ago
            across {failedSourceCount}. Retrying automatically.
          </>
        ) : cachedAge !== null ? (
          <>
            Showing cached data from {cachedAge} ago across {cachedSourceCount}.
            Refreshing…
          </>
        ) : null}
        {status.failedCount > 0 &&
        status.cachedCount > 0 &&
        cachedAge !== null ? (
          <>
            {" "}
            Also showing cached data from {cachedAge} ago across{" "}
            {cachedSourceCount} while it refreshes.
          </>
        ) : null}
        {status.lastErrorMessage ? (
          <span className="sr-only">
            {" "}
            Last error: {status.lastErrorMessage}
          </span>
        ) : null}
      </div>
    </div>
  );
}
