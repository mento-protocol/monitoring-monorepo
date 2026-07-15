"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  SWRConfig,
  useSWRConfig,
  type Middleware,
  type SWRConfiguration,
} from "swr";
import * as Sentry from "@sentry/nextjs";
import {
  normalizeSWRFreshnessKey,
  markSWRFreshnessCached,
  registerSWRFreshnessKey,
  recordSWRFreshnessError,
  recordSWRFreshnessSuccess,
  seedSWRFreshnessData,
} from "@/lib/swr-freshness";
import {
  createPersistedSWRCache,
  type PersistedSWRCacheController,
} from "@/lib/swr-persisted-cache";

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

function captureSWRError(err: unknown, key: unknown) {
  const normalized = normalizeSWRFreshnessKey(key);
  if (!shouldCapture(normalized)) return;
  Sentry.captureException(err, {
    tags: { source: "swr" },
    extra: { swrKey: normalized },
  });
}

function readRefreshIntervalMs(config: SWRConfiguration | undefined) {
  const refreshInterval = config?.refreshInterval;
  return typeof refreshInterval === "number" && refreshInterval > 0
    ? refreshInterval
    : null;
}

function createFreshnessMiddleware(
  persistedCache: PersistedSWRCacheController,
): Middleware {
  return (useSWRNext) => {
    return (key, fetcher, config) => {
      const refreshIntervalMs = readRefreshIntervalMs(config);
      const freshnessKey =
        key == null || typeof key === "function" || refreshIntervalMs === null
          ? null
          : normalizeSWRFreshnessKey(key);
      const trackedConfig: SWRConfiguration = {
        ...config,
        onError(err, callbackKey, callbackConfig) {
          recordSWRFreshnessError(err, callbackKey, callbackConfig);
          config?.onError?.(err, callbackKey, callbackConfig);
        },
        onSuccess(data, callbackKey, callbackConfig) {
          persistedCache.recordNetworkSuccess(callbackKey);
          recordSWRFreshnessSuccess(callbackKey, callbackConfig);
          config?.onSuccess?.(data, callbackKey, callbackConfig);
        },
      };
      const response = useSWRNext(key, fetcher, trackedConfig);

      useEffect(() => {
        if (freshnessKey === null || refreshIntervalMs === null) return;
        return registerSWRFreshnessKey(freshnessKey);
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
}

// Hoisted to module scope so the config object identity is stable across
// renders — an inline object literal would bust context consumers every
// time SwrProvider re-renders.
//
// Focus/reconnect revalidation is *not* disabled globally — only the
// bridge-flows hook opts out (see `use-bridge-gql.ts`), since that's where
// the 429 fanout came from. Leaving the global default on means regular
// one-shot SWR reads still refresh when the user returns to a tab or the
// network recovers.
const baseSWRConfig: SWRConfiguration = {
  onError(err, key) {
    captureSWRError(err, key);
  },
};

function PersistedCacheActivator({
  persistedCache,
}: {
  persistedCache: PersistedSWRCacheController;
}) {
  const { mutate } = useSWRConfig();

  useEffect(() => {
    for (const entry of persistedCache.consumeHydratedEntries()) {
      // If the mounted hook already produced real data, the network wins the
      // race and the older storage snapshot is discarded.
      // react-doctor-disable-next-line effect/no-pass-data-to-parent -- post-hydration activation must publish into provider-scoped SWR state
      if (persistedCache.cache.get(entry.key)?.data !== undefined) continue;

      markSWRFreshnessCached(entry.key, entry.updatedAt);
      // This mutate belongs to the custom provider. Populate after hydration,
      // then trigger the hook's normal revalidation without awaiting it.
      void mutate(entry.key, entry.data, { revalidate: false })
        .then(() => mutate(entry.key))
        .catch(() => undefined);
    }
  }, [mutate, persistedCache]);

  return null;
}

export function SwrProvider({ children }: { children: ReactNode }) {
  const [persistedCache] = useState(() => createPersistedSWRCache());
  useEffect(() => persistedCache.attachLifecycleFlushes(), [persistedCache]);
  const swrConfig = useMemo<SWRConfiguration>(
    () => ({
      ...baseSWRConfig,
      provider: () => persistedCache.cache,
      use: [createFreshnessMiddleware(persistedCache)],
    }),
    [persistedCache],
  );
  return (
    <SWRConfig value={swrConfig}>
      <PersistedCacheActivator persistedCache={persistedCache} />
      {children}
    </SWRConfig>
  );
}
