"use client";

import { useEffect, type ReactNode } from "react";
import { SWRConfig, type Middleware, type SWRConfiguration } from "swr";
import * as Sentry from "@sentry/nextjs";
import {
  normalizeSWRFreshnessKey,
  registerSWRFreshnessKey,
  recordSWRFreshnessError,
  recordSWRFreshnessSuccess,
  seedSWRFreshnessData,
} from "@/lib/swr-freshness";

// Global SWR onError handler: funnel every fetch failure to Sentry with the
// SWR cache key attached as extra data. Without this, caught errors surface
// as an ErrorBox in the UI and vanish from observability. Individual hooks
// can still override by passing their own `onError` to useSWR.
//
// Capture is throttled per-key so polling hooks don't flood Sentry during
// an upstream outage — one Hasura timeout fans out to dozens of identical
// events per minute otherwise.
const THROTTLE_MS = 60_000;
const lastCapturedAt = new Map<string, number>();

function shouldCapture(normalized: string): boolean {
  const now = Date.now();
  const last = lastCapturedAt.get(normalized) ?? 0;
  if (now - last < THROTTLE_MS) return false;
  lastCapturedAt.set(normalized, now);
  return true;
}

function readRefreshIntervalMs(config: SWRConfiguration | undefined) {
  const refreshInterval = config?.refreshInterval;
  return typeof refreshInterval === "number" && refreshInterval > 0
    ? refreshInterval
    : null;
}

const freshnessMiddleware: Middleware = (useSWRNext) => {
  return (key, fetcher, config) => {
    const refreshIntervalMs = readRefreshIntervalMs(config);
    const freshnessKey =
      key == null || typeof key === "function" || refreshIntervalMs === null
        ? null
        : normalizeSWRFreshnessKey(key);
    const response = useSWRNext(key, fetcher, config);

    useEffect(() => {
      if (freshnessKey === null || refreshIntervalMs === null) return;
      return registerSWRFreshnessKey(freshnessKey, refreshIntervalMs);
    }, [freshnessKey, refreshIntervalMs]);

    useEffect(() => {
      if (
        freshnessKey === null ||
        refreshIntervalMs === null ||
        response.data === undefined
      ) {
        return;
      }
      seedSWRFreshnessData(freshnessKey, {
        refreshInterval: refreshIntervalMs,
      });
    }, [freshnessKey, refreshIntervalMs, response.data]);

    return response;
  };
};

// Hoisted to module scope so the config object identity is stable across
// renders — an inline object literal would bust context consumers every
// time SwrProvider re-renders.
//
// Focus/reconnect revalidation is *not* disabled globally — only the
// bridge-flows hook opts out (see `use-bridge-gql.ts`), since that's where
// the 429 fanout came from. Leaving the global default on means regular
// one-shot SWR reads still refresh when the user returns to a tab or the
// network recovers.
const swrConfig: SWRConfiguration = {
  use: [freshnessMiddleware],
  onError(err, key, config) {
    recordSWRFreshnessError(err, key, config);
    const normalized = normalizeSWRFreshnessKey(key);
    if (!shouldCapture(normalized)) return;
    Sentry.captureException(err, {
      tags: { source: "swr" },
      extra: { swrKey: normalized },
    });
  },
  onSuccess(_data, key, config) {
    recordSWRFreshnessSuccess(key, config);
  },
};

export function SwrProvider({ children }: { children: ReactNode }) {
  return <SWRConfig value={swrConfig}>{children}</SWRConfig>;
}
