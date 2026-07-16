"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  SWRConfig,
  useSWRConfig,
  type Middleware,
  type SWRConfiguration,
} from "swr";
import { createCacheHelper, getTimestamp, SWRGlobalState } from "swr/_internal";
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

export function PersistedCacheActivator({
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

      // Publish through SWR's cache helper so subscribers repaint without
      // stamping a mutation over a request that the mounted hook already has
      // in flight. A functional mutate here would make SWR discard that
      // response; following it with another mutate would issue a duplicate.
      const [readCache, publishCache] = createCacheHelper(
        persistedCache.cache,
        entry.key,
      );
      const current = readCache();
      if (current.data !== undefined) {
        // The inner read is the atomic network-wins check. Re-publish that
        // winner so every provider subscriber observes it.
        publishCache({});
        continue;
      }

      const hasInFlightRequest =
        SWRGlobalState.get(persistedCache.cache)?.[2][entry.key] !== undefined;
      const failedRequestError = current.error;
      const hasFailedRequest = failedRequestError !== undefined;
      if (hasFailedRequest) {
        // SWR removes its in-flight marker as soon as a request rejects. Keep
        // that completed attempt's error (and its configured retry/backoff)
        // instead of clearing it and immediately issuing a second request.
        publishCache({ data: entry.data });

        const fetches = SWRGlobalState.get(persistedCache.cache)?.[2];
        if (fetches !== undefined && fetches[entry.key] === undefined) {
          // React StrictMode replays the hook's mount effect immediately after
          // this passive effect. Keep a one-microtask SWR dedupe marker so that
          // replay observes the completed request instead of starting another.
          const replayGuard: [Promise<unknown>, number] = [
            Promise.resolve(entry.data),
            getTimestamp(),
          ];
          fetches[entry.key] = replayGuard;
          void replayGuard[0].then(() => {
            if (fetches[entry.key] === replayGuard) delete fetches[entry.key];
          });
        }
      } else {
        publishCache({ data: entry.data, error: undefined });
      }
      markSWRFreshnessCached(entry.key, entry.updatedAt);
      if (hasFailedRequest) {
        // Establish cachedAt first, then restore the failure that this load
        // already observed so the freshness banner remains degraded.
        recordSWRFreshnessError(failedRequestError, entry.key);
      }

      // Reuse mount revalidation when it exists. With no mounted consumer,
      // this is a no-op and a later hook follows its own revalidate-on-mount
      // policy against the cached value.
      if (!hasInFlightRequest && !hasFailedRequest) {
        void mutate(entry.key).catch(() => undefined);
      }
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
