/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import useSWR, {
  preload,
  SWRConfig,
  unstable_serialize,
  type State,
} from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataFreshnessBanner } from "@/components/data-freshness-banner";
import {
  PersistedCacheActivator,
  SwrProvider,
} from "@/components/swr-provider";
import { TRADING_LIMITS } from "@/lib/queries";
import {
  createPersistedSWRCache,
  SWR_PERSISTED_CACHE_STORAGE_KEY,
  type PersistedSWRCacheController,
} from "@/lib/swr-persisted-cache";
import { resetSWRFreshnessForTests } from "@/lib/swr-freshness";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const NOW = 1_767_225_600_000;

let container: HTMLDivElement;
let root: Root;

type TriggerRef = {
  current: (() => Promise<unknown>) | null;
};

type FallbackPayload = {
  ready: boolean;
};

const stableSuccessPayload: FallbackPayload = { ready: true };
const persistedTradingLimitsKey = [
  "celo-mainnet",
  TRADING_LIMITS,
  { poolId: "42220-0xpool" },
] as const;

type TradingLimitsPayload = {
  TradingLimit: Array<{ id: string }>;
};

const providerPreloadKey = "provider-preload-key";

function ProviderCacheProbe() {
  const { data } = useSWR<TradingLimitsPayload>(
    persistedTradingLimitsKey,
    null,
    { revalidateOnMount: false },
  );
  return (
    <>
      <DataFreshnessBanner />
      <div>{data?.TradingLimit[0]?.id ?? "missing"}</div>
    </>
  );
}

function PreloadProbe({
  fetcher,
}: {
  fetcher: () => Promise<FallbackPayload>;
}) {
  const { data } = useSWR<FallbackPayload>(providerPreloadKey, fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  return <div>{data?.ready ? "preload ready" : "missing"}</div>;
}

function FallbackDataProbe({ triggerRef }: { triggerRef: TriggerRef }) {
  const { data, mutate } = useSWR<FallbackPayload>(
    "fallback-freshness-key",
    async () => {
      throw new Error("first refresh failed");
    },
    {
      fallbackData: { ready: true },
      refreshInterval: 30_000,
      revalidateOnMount: false,
      shouldRetryOnError: false,
    },
  );
  triggerRef.current = () => mutate();

  return (
    <>
      <DataFreshnessBanner />
      <div>{data?.ready ? "fallback ready" : "missing"}</div>
    </>
  );
}

function CustomSuccessProbe({
  onSuccess,
  triggerRef,
}: {
  onSuccess: () => void;
  triggerRef: TriggerRef;
}) {
  const { data, mutate } = useSWR<FallbackPayload>(
    "custom-success-freshness-key",
    async () => stableSuccessPayload,
    {
      fallbackData: stableSuccessPayload,
      onSuccess,
      refreshInterval: 30_000,
      revalidateOnMount: false,
    },
  );
  triggerRef.current = () => mutate();

  return (
    <>
      <DataFreshnessBanner />
      <div>{data?.ready ? "custom ready" : "missing"}</div>
    </>
  );
}

function PersistedTradingLimitsProbe({
  networkResponse,
  triggerRef,
}: {
  networkResponse: Promise<TradingLimitsPayload>;
  triggerRef: TriggerRef;
}) {
  const { data, mutate } = useSWR<TradingLimitsPayload>(
    persistedTradingLimitsKey,
    () => networkResponse,
    {
      refreshInterval: 30_000,
      revalidateOnMount: true,
      shouldRetryOnError: false,
    },
  );
  triggerRef.current = () => mutate();

  return (
    <>
      <DataFreshnessBanner />
      <div>{data?.TradingLimit[0]?.id ?? "missing"}</div>
    </>
  );
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetSWRFreshnessForTests();
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  resetSWRFreshnessForTests();
  window.localStorage.clear();
  container.remove();
  vi.useRealTimers();
});

describe("SwrProvider freshness tracking", () => {
  it("seeds fallback data as last-good data before the first refresh fails", async () => {
    const triggerRef: TriggerRef = { current: null };

    act(() => {
      root.render(
        <SwrProvider>
          <FallbackDataProbe triggerRef={triggerRef} />
        </SwrProvider>,
      );
    });

    expect(container.textContent).toContain("fallback ready");
    expect(container.textContent).not.toContain("Latest refresh failed");

    await act(async () => {
      vi.setSystemTime(NOW + 1_000);
      await triggerRef.current?.().catch(() => undefined);
    });

    expect(container.textContent).toContain("Latest refresh failed");
    expect(container.textContent).toContain("last-good data from 1s ago");

    act(() => root.unmount());
    root = createRoot(container);

    const remountTriggerRef: TriggerRef = { current: null };
    act(() => {
      root.render(
        <SwrProvider>
          <FallbackDataProbe triggerRef={remountTriggerRef} />
        </SwrProvider>,
      );
    });

    expect(container.textContent).toContain("fallback ready");
    expect(container.textContent).toContain("Latest refresh failed");
    expect(container.textContent).toContain("last-good data from 1s ago");
  });

  it("keeps successful unchanged SWR data from showing an overdue-only banner", async () => {
    const onSuccess = vi.fn();
    const triggerRef: TriggerRef = { current: null };

    act(() => {
      root.render(
        <SwrProvider>
          <CustomSuccessProbe onSuccess={onSuccess} triggerRef={triggerRef} />
        </SwrProvider>,
      );
    });

    act(() => {
      vi.setSystemTime(NOW + 31_000);
      vi.advanceTimersByTime(31_000);
    });

    expect(container.textContent).not.toContain("Latest refresh failed");
    expect(container.textContent).not.toContain("Data may be stale");

    await act(async () => {
      await triggerRef.current?.();
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("custom ready");
    expect(container.textContent).not.toContain("Latest refresh failed");
    expect(container.textContent).not.toContain("Data may be stale");
  });

  it("keeps persisted data cached until the network callback updates the same provider key", async () => {
    const cachedAt = NOW - 10_000;
    const seed = createPersistedSWRCache({
      buildSalt: "dev",
      now: () => cachedAt,
      storage: window.localStorage,
    });
    const serializedKey = unstable_serialize(persistedTradingLimitsKey);
    seed.cache.set(serializedKey, {
      data: { TradingLimit: [{ id: "cached-limit" }] },
    });
    seed.recordNetworkSuccess(persistedTradingLimitsKey);
    expect(seed.flush()).toBeGreaterThan(0);
    resetSWRFreshnessForTests();

    let resolveNetwork!: (data: TradingLimitsPayload) => void;
    const networkResponse = new Promise<TradingLimitsPayload>((resolve) => {
      resolveNetwork = resolve;
    });
    const triggerRef: TriggerRef = { current: null };

    await act(async () => {
      root.render(
        <SwrProvider>
          <PersistedTradingLimitsProbe
            networkResponse={networkResponse}
            triggerRef={triggerRef}
          />
        </SwrProvider>,
      );
    });

    expect(container.textContent).toContain("cached-limit");
    expect(container.textContent).toContain("Showing cached data from 10s ago");

    let revalidation: Promise<unknown> | null = null;
    act(() => {
      revalidation = triggerRef.current?.() ?? null;
    });
    await act(async () => {
      resolveNetwork({ TradingLimit: [{ id: "network-limit" }] });
      await networkResponse;
      await revalidation;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("network-limit");
    expect(container.textContent).not.toContain("Showing cached data");

    act(() => {
      vi.advanceTimersByTime(250);
    });
    const raw = window.localStorage.getItem(SWR_PERSISTED_CACHE_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw!) as {
      entries: Array<{ data: TradingLimitsPayload; key: string }>;
      savedAt: number;
    };
    expect(record.savedAt).toBe(NOW);
    expect(record.entries).toEqual([
      {
        data: { TradingLimit: [{ id: "network-limit" }] },
        key: serializedKey,
        updatedAt: NOW,
      },
    ]);
  });

  it("keeps a network success that lands between the activation check and provider mutate", async () => {
    const serializedKey = unstable_serialize(persistedTradingLimitsKey);
    const networkData: TradingLimitsPayload = {
      TradingLimit: [{ id: "network-won-race" }],
    };
    const persistedData: TradingLimitsPayload = {
      TradingLimit: [{ id: "persisted-lost-race" }],
    };

    class NetworkWinsRaceCache extends Map<string, State<unknown>> {
      private armed = false;

      arm() {
        this.armed = true;
      }

      override get(key: string): State<unknown> | undefined {
        const current = super.get(key);
        if (this.armed && key === serializedKey) {
          this.armed = false;
          // Simulate SWR committing a successful response after the activator's
          // first read but before its provider-scoped mutate applies.
          super.set(key, { ...current, data: networkData });
        }
        return current;
      }
    }

    const raceCache = new NetworkWinsRaceCache();
    const persistedCache = {
      cache: raceCache,
      attachLifecycleFlushes: () => () => undefined,
      consumeHydratedEntries: () => {
        raceCache.arm();
        return [
          {
            data: persistedData,
            key: serializedKey,
            updatedAt: NOW - 10_000,
          },
        ];
      },
      flush: () => null,
      recordNetworkSuccess: () => undefined,
    } satisfies PersistedSWRCacheController;

    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => raceCache }}>
          <PersistedCacheActivator persistedCache={persistedCache} />
          <ProviderCacheProbe />
        </SWRConfig>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(raceCache.get(serializedKey)?.data).toEqual(networkData);
    expect(container.textContent).toContain("network-won-race");
    expect(container.textContent).not.toContain("persisted-lost-race");
    expect(container.textContent).not.toContain("Showing cached data");
  });

  it("keeps SSR hydration stable before warm-painting the staged cache", async () => {
    const cachedAt = NOW - 10_000;
    const seed = createPersistedSWRCache({
      buildSalt: "dev",
      now: () => cachedAt,
      storage: window.localStorage,
    });
    seed.cache.set(unstable_serialize(persistedTradingLimitsKey), {
      data: { TradingLimit: [{ id: "cached-after-hydration" }] },
    });
    seed.recordNetworkSuccess(persistedTradingLimitsKey);
    expect(seed.flush()).toBeGreaterThan(0);
    resetSWRFreshnessForTests();

    const networkResponse = new Promise<TradingLimitsPayload>(() => {});
    const triggerRef: TriggerRef = { current: null };
    const tree = (
      <SwrProvider>
        <PersistedTradingLimitsProbe
          networkResponse={networkResponse}
          triggerRef={triggerRef}
        />
      </SwrProvider>
    );

    act(() => root.unmount());
    const persistedRecord = window.localStorage.getItem(
      SWR_PERSISTED_CACHE_STORAGE_KEY,
    );
    expect(persistedRecord).not.toBeNull();
    window.localStorage.clear();
    const serverMarkup = renderToString(tree);
    expect(serverMarkup).toContain("missing");
    expect(serverMarkup).not.toContain("cached-after-hydration");
    container.innerHTML = serverMarkup;
    window.localStorage.setItem(
      SWR_PERSISTED_CACHE_STORAGE_KEY,
      persistedRecord!,
    );

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await act(async () => {
      root = hydrateRoot(container, tree);
      await Promise.resolve();
      await Promise.resolve();
    });
    const hydrationErrors: string[] = [];
    const hydrationErrorPattern = /Hydration failed|didn't match the client/;
    for (const call of consoleError.mock.calls) {
      for (const argument of call) {
        const message = String(argument);
        if (hydrationErrorPattern.test(message)) {
          hydrationErrors.push(message);
        }
      }
    }
    consoleError.mockRestore();

    expect(hydrationErrors).toEqual([]);
    expect(container.textContent).toContain("cached-after-hydration");
    expect(container.textContent).toContain("Showing cached data from 10s ago");
  });

  it("consumes SWR's global preload under the custom provider", async () => {
    const preloadedFetcher = vi.fn(async () => stableSuccessPayload);
    const hookFetcher = vi.fn(async () => ({ ready: false }));
    preload(providerPreloadKey, preloadedFetcher);

    await act(async () => {
      root.render(
        <SwrProvider>
          <PreloadProbe fetcher={hookFetcher} />
        </SwrProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("preload ready");
    expect(preloadedFetcher).toHaveBeenCalledTimes(1);
    expect(hookFetcher).not.toHaveBeenCalled();
  });
});
