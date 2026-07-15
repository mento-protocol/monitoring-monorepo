/** @vitest-environment jsdom */

import { act, StrictMode } from "react";
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
import type { TradingLimitsQuery } from "@/lib/__generated__/graphql";
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

type TradingLimitsPayload = TradingLimitsQuery;

function tradingLimitsPayload(id: string): TradingLimitsPayload {
  return {
    TradingLimit: [
      {
        id,
        token: "0xtoken",
        limit0: "100",
        limit1: "200",
        decimals: 18,
        netflow0: "10",
        netflow1: "20",
        lastUpdated0: "1000",
        lastUpdated1: "2000",
        limitPressure0: "0.1",
        limitPressure1: "0.2",
        limitStatus: "OK",
        updatedAtBlock: "123",
        updatedAtTimestamp: "3000",
      },
    ],
  };
}

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
  fetcher,
  refreshInterval = 30_000,
}: {
  fetcher: () => Promise<TradingLimitsPayload>;
  refreshInterval?: number;
}) {
  const { data } = useSWR<TradingLimitsPayload>(
    persistedTradingLimitsKey,
    fetcher,
    {
      refreshInterval,
      revalidateOnMount: true,
      shouldRetryOnError: false,
    },
  );
  return (
    <>
      <DataFreshnessBanner />
      <div>{data?.TradingLimit[0]?.id ?? "missing"}</div>
    </>
  );
}

function ImmediateFailureTradingLimitsProbe({
  fetcher,
  onError,
}: {
  fetcher: () => Promise<TradingLimitsPayload>;
  onError: (error: unknown) => void;
}) {
  const { data, error } = useSWR<TradingLimitsPayload>(
    persistedTradingLimitsKey,
    fetcher,
    {
      errorRetryCount: 1,
      errorRetryInterval: 250,
      loadingTimeout: 0,
      onError,
      refreshInterval: 30_000,
      revalidateOnMount: true,
    },
  );
  return (
    <>
      <DataFreshnessBanner />
      <div>{data?.TradingLimit[0]?.id ?? "missing"}</div>
      <div>{error instanceof Error ? error.message : "no error"}</div>
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
    const cachedData = tradingLimitsPayload("cached-limit");
    const networkData = tradingLimitsPayload("network-limit");
    seed.cache.set(serializedKey, {
      data: cachedData,
    });
    seed.recordNetworkSuccess(persistedTradingLimitsKey);
    expect(seed.flush()).toBeGreaterThan(0);
    resetSWRFreshnessForTests();

    let resolveNetwork!: (data: TradingLimitsPayload) => void;
    const networkResponse = new Promise<TradingLimitsPayload>((resolve) => {
      resolveNetwork = resolve;
    });
    const fetcher = vi.fn(() => networkResponse);

    await act(async () => {
      root.render(
        <SwrProvider>
          <PersistedTradingLimitsProbe fetcher={fetcher} />
        </SwrProvider>,
      );
    });

    expect(container.textContent).toContain("cached-limit");
    expect(container.textContent).toContain("Showing cached data from 10s ago");
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveNetwork(networkData);
      await networkResponse;
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
        data: networkData,
        key: serializedKey,
        updatedAt: NOW,
      },
    ]);
  });

  it("keeps SWR's backoff after an immediate mount failure", async () => {
    vi.useRealTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const cachedAt = Date.now() - 10_000;
    const seed = createPersistedSWRCache({
      buildSalt: "dev",
      now: () => cachedAt,
      storage: window.localStorage,
    });
    seed.cache.set(unstable_serialize(persistedTradingLimitsKey), {
      data: tradingLimitsPayload("cached-after-failure"),
    });
    seed.recordNetworkSuccess(persistedTradingLimitsKey);
    expect(seed.flush()).toBeGreaterThan(0);
    resetSWRFreshnessForTests();

    const originalError = new Error("immediate mount failure");
    const fetcher = vi.fn(async () => {
      throw originalError;
    });
    const onError = vi.fn();

    // Do not wrap this concurrent-root render in `act`: act flushes passive
    // effects before rejected-promise microtasks, masking the production race
    // where SWR records the failure before cache activation runs.
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      root.render(
        <StrictMode>
          <SwrProvider>
            <ImmediateFailureTradingLimitsProbe
              fetcher={fetcher}
              onError={onError}
            />
          </SwrProvider>
        </StrictMode>,
      );

      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      expect(container.textContent).toContain("cached-after-failure");
      expect(container.textContent).toContain("immediate mount failure");
      expect(container.textContent).toContain("Latest refresh failed");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toBe(originalError);

      // With Math.random fixed at zero, SWR's first exponential-backoff retry
      // is due after 250ms. The activator must neither bypass nor cancel it.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError.mock.calls[1]?.[0]).toBe(originalError);
    } finally {
      randomSpy.mockRestore();
      reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it("keeps a network success that lands between the activation check and provider publish", async () => {
    const serializedKey = unstable_serialize(persistedTradingLimitsKey);
    const networkData = tradingLimitsPayload("network-won-race");
    const persistedData = tradingLimitsPayload("persisted-lost-race");

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
          // first read but before its provider-scoped publish applies.
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

  it("revalidates once when the consumer mounts after cache activation", async () => {
    const cachedAt = NOW - 10_000;
    const seed = createPersistedSWRCache({
      buildSalt: "dev",
      now: () => cachedAt,
      storage: window.localStorage,
    });
    seed.cache.set(unstable_serialize(persistedTradingLimitsKey), {
      data: tradingLimitsPayload("cached-before-mount"),
    });
    seed.recordNetworkSuccess(persistedTradingLimitsKey);
    expect(seed.flush()).toBeGreaterThan(0);
    resetSWRFreshnessForTests();

    let resolveNetwork!: (data: TradingLimitsPayload) => void;
    const networkResponse = new Promise<TradingLimitsPayload>((resolve) => {
      resolveNetwork = resolve;
    });
    const fetcher = vi.fn(() => networkResponse);

    await act(async () => {
      root.render(<SwrProvider>consumer not mounted</SwrProvider>);
      await Promise.resolve();
    });
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <SwrProvider>
          <PersistedTradingLimitsProbe fetcher={fetcher} refreshInterval={0} />
        </SwrProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("cached-before-mount");
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveNetwork(tradingLimitsPayload("network-after-mount"));
      await networkResponse;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("network-after-mount");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps SSR hydration stable before warm-painting the staged cache", async () => {
    const cachedAt = NOW - 10_000;
    const seed = createPersistedSWRCache({
      buildSalt: "dev",
      now: () => cachedAt,
      storage: window.localStorage,
    });
    const cachedData = tradingLimitsPayload("cached-after-hydration");
    seed.cache.set(unstable_serialize(persistedTradingLimitsKey), {
      data: cachedData,
    });
    seed.recordNetworkSuccess(persistedTradingLimitsKey);
    expect(seed.flush()).toBeGreaterThan(0);
    resetSWRFreshnessForTests();

    const networkResponse = new Promise<TradingLimitsPayload>(() => {});
    const fetcher = vi.fn(() => networkResponse);
    const tree = (
      <SwrProvider>
        <PersistedTradingLimitsProbe fetcher={fetcher} />
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
