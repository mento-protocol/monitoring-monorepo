/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { BreakerPanel } from "@/components/breaker-panel";
import type { Pool, BreakerConfig, BreakerTripEvent } from "@/lib/types";
import { formatTimestamp, timestampOrUtc } from "@/lib/format";

const mockUseGQL = vi.fn();
vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      testnet: false,
      hasVirtualPools: true,
      contractsNamespace: "mainnet",
      hasuraUrl: "",
      hasuraSecret: "",
    },
  }),
}));

vi.mock("@/components/tooltip", () => ({
  Tooltip: () => null,
}));

const FX_FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";

function fxPool(): Pool {
  return {
    id: `42220-0x6297000000000000000000000000000000000000`,
    chainId: 42220,
    token0: "0x0000000000000000000000000000000000000010",
    token1: "0x0000000000000000000000000000000000000020",
    token0Decimals: 18,
    token1Decimals: 18,
    source: "fpmm_factory",
    referenceRateFeedID: FX_FEED,
  } as unknown as Pool;
}

function virtualPool(): Pool {
  return { ...fxPool(), source: "virtual_pool_factory" } as unknown as Pool;
}

function noFeedPool(): Pool {
  return { ...fxPool(), referenceRateFeedID: "" } as unknown as Pool;
}

function healthyMedianConfig(): BreakerConfig {
  return {
    id: "1",
    enabled: true,
    cooldownTime: "0", // inherit default
    rateChangeThreshold: "0", // inherit default
    smoothingFactor: "5000000000000000000000", // 0.5%
    medianRatesEMA: "1171560280196965000000000", // 1.171…
    referenceValue: null,
    lastMedianRate: "1175000000000000000000000", // 1.175 — small Δ from EMA
    lastUpdatedAt: "1700000000",
    status: "OK",
    tradingMode: 0,
    lastStatusUpdatedAt: "1700000000",
    cooldownEndsAt: "0",
    lastTripAt: null,
    lastTripTxHash: null,
    lastResetAt: null,
    tripCountLifetime: 0,
    breaker: {
      id: "b",
      address: "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9",
      kind: "MEDIAN_DELTA",
      activatesTradingMode: 3,
      defaultCooldownTime: "900",
      defaultRateChangeThreshold: "40000000000000000000000", // 4%
    },
  };
}

function trippedMedianConfig(): BreakerConfig {
  return {
    ...healthyMedianConfig(),
    status: "TRIPPED",
    tradingMode: 3,
    lastStatusUpdatedAt: "1700001000",
    // Cooldown expires 900s after trip — set well into the future from
    // the test's "now" so the panel renders the not-yet-elapsed state.
    cooldownEndsAt: String(Math.floor(Date.now() / 1000) + 600),
    lastTripAt: "1700001000",
    lastTripTxHash:
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    tripCountLifetime: 4,
    // Live Δ is over threshold — 5% from EMA.
    lastMedianRate: "1230000000000000000000000",
  };
}

function healthyValueConfig(): BreakerConfig {
  return {
    id: "2",
    enabled: true,
    cooldownTime: "0",
    rateChangeThreshold: "0",
    smoothingFactor: null,
    medianRatesEMA: null,
    referenceValue: "1000000000000000000000000", // 1.0 peg
    lastMedianRate: "1000100000000000000000000", // 1.0001
    lastUpdatedAt: "1700000000",
    status: "OK",
    tradingMode: 0,
    lastStatusUpdatedAt: "1700000000",
    cooldownEndsAt: "0",
    lastTripAt: null,
    lastTripTxHash: null,
    lastResetAt: null,
    tripCountLifetime: 0,
    breaker: {
      id: "b2",
      address: "0x4dbc33b3aba78475a5aa4bc7a5b11445d387bf68",
      kind: "VALUE_DELTA",
      activatesTradingMode: 3,
      defaultCooldownTime: "1",
      defaultRateChangeThreshold: "1500000000000000000000", // 0.15%
    },
  };
}

function trippedValueConfig(): BreakerConfig {
  return {
    ...healthyValueConfig(),
    status: "TRIPPED",
    tradingMode: 3,
    cooldownEndsAt: String(Math.floor(Date.now() / 1000) + 600),
    lastTripAt: "1700001000",
    lastTripTxHash:
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    tripCountLifetime: 1,
    lastMedianRate: "997000000000000000000000", // 0.3% below peg
  };
}

const noTrips: BreakerTripEvent[] = [];

// react-dom/client's `act` + `hydrateRoot` idiom needs this flag (same
// setup as market-hours-pill.test.tsx) — only the hydration-safety describe
// block below exercises it, but the flag has to be set before hydrateRoot
// runs and restored after, so it lives in the suite's beforeEach/afterEach.
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let previousActEnvironment: boolean | undefined;

describe("BreakerPanel", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
    previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment ?? false;
  });

  it("renders nothing for virtual pools", () => {
    mockUseGQL.mockReturnValue({ data: undefined });
    const html = renderToStaticMarkup(<BreakerPanel pool={virtualPool()} />);
    expect(html).toBe("");
  });

  it("renders nothing for pools without a referenceRateFeedID", () => {
    mockUseGQL.mockReturnValue({ data: undefined });
    const html = renderToStaticMarkup(<BreakerPanel pool={noFeedPool()} />);
    expect(html).toBe("");
  });

  it("renders a 5-stat skeleton (not nothing) while the query is still loading", () => {
    // Degraded path only (SSR prefetch missed, so no fallbackData): with the
    // query genuinely in flight the panel must render a matching-shape shimmer,
    // not `null` (issue #1222: a null→content swap here measured as +119px on
    // PoolHeader). When the #1237 prefetch supplies fallbackData, `data` is
    // populated on first paint and this skeleton branch is skipped entirely.
    mockUseGQL.mockReturnValue({ data: undefined, isLoading: true });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).not.toBe("");
    // Same grid shape as the loaded `<dl>` — 5 stat cells behind the
    // hairline divider that always precedes the real content.
    expect(html).toContain("my-5 h-px bg-slate-800");
    const dlOpenTag = html.match(/<dl[^>]*>/)?.[0] ?? "";
    expect(dlOpenTag).toContain("lg:grid-cols-5");
    // Each stat cell's label bar carries this exact class pair — 5 stat
    // cells behind the divider, matching the real panel's 5 `<dl>` children
    // (Breaker, Reference vs Actual, Threshold/Cooldown, live-Δ, Last trip).
    const statCellCount = (html.match(/h-3 w-24/g) ?? []).length;
    expect(statCellCount).toBe(5);
    // Each cell reserves the loaded row's measured 78px height (three text
    // lines: label, value, sub-line) so the header card doesn't grow once
    // BreakerConfig resolves.
    const cellHeightCount = (html.match(/h-\[78px\]/g) ?? []).length;
    expect(cellHeightCount).toBe(5);
  });

  it("renders nothing once the query resolves and finds no trip-able breaker (not stuck on the skeleton)", () => {
    mockUseGQL.mockReturnValue({
      data: { BreakerConfig: [], BreakerTripEvent: noTrips },
      isLoading: false,
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toBe("");
  });

  it("renders nothing when the feed has no trip-able BreakerConfig (only MARKET_HOURS)", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [
          {
            ...healthyMedianConfig(),
            breaker: { ...healthyMedianConfig().breaker, kind: "MARKET_HOURS" },
          },
        ],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toBe("");
  });

  it("renders the healthy MedianDelta strip", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [healthyMedianConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("MedianDelta");
    expect(html).toContain("EMA Reference vs Actual");
    expect(html).toContain("ref ");
    expect(html).toContain("actual ");
    expect(html).toContain("Threshold / Cooldown");
    expect(html).toContain("Δ Oracle Price vs EMA");
    expect(html).toContain("4.00%"); // default threshold inherited
    expect(html).toContain("15m"); // 900s formatted
    expect(html).toContain("trips at &gt;4.00% from EMA");
    expect(html).toContain("0 lifetime");
    expect(html).not.toContain("Reset path"); // not tripped
    expect(html).toContain("text-emerald-400"); // OK label
  });

  it("renders the healthy ValueDelta strip with peg reference", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [healthyValueConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("ValueDelta");
    expect(html).toContain("Reference vs Actual");
    expect(html).not.toContain("EMA Reference vs Actual");
    expect(html).toContain("fixed peg");
    expect(html).toContain("Δ Oracle Price vs Peg");
    expect(html).toContain("0.150%");
    expect(html).toContain("from peg");
  });

  it("renders breached ValueDelta reference and actual values in red with peg drift", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [trippedValueConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("Reference vs Actual");
    expect(html).toContain("ref ");
    expect(html).toContain("1.000000");
    expect(html).toContain("actual ");
    expect(html).toContain("0.997000");
    expect(html).toContain("0.300% below peg");
    expect(html).toContain("font-mono text-red-300");
  });

  it("renders the tripped MedianDelta strip with reset-path banner", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [trippedMedianConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("text-red-400"); // Tripped label
    expect(html).toContain("trading mode 3");
    expect(html).toContain("halted");
    expect(html).toContain("Reset path"); // banner present
    expect(html).toContain("Cooldown");
    expect(html).toContain("Rate in band");
    expect(html).toContain("Next oracle report");
    expect(html).toContain("4 lifetime");
    // Reset path checkboxes: cooldown is NOT elapsed (we set cooldownEndsAt
    // to now+600), so the row should render the ✗ marker.
    expect(html).toContain("✗");
  });

  it("hides the 'today' suffix when zero trips have happened today", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [healthyMedianConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("0 lifetime");
    expect(html).not.toContain("today");
  });

  describe("stale breaker refresh (Codex finding, issue #1257)", () => {
    it("discloses a failed revalidation while showing last-known fallback data instead of presenting the breaker status as freshly resolved", () => {
      // fallbackData keeps `data` populated across a failed client
      // revalidation (SWR sets `error`, keeps the last-good `data`). On a
      // monitoring tool the stale status must NOT read as fresh — surface the
      // same "showing the last confirmed state" affordance the pool-health
      // path uses, while still rendering the last-known strip beneath it.
      mockUseGQL.mockReturnValue({
        data: {
          BreakerConfig: [healthyMedianConfig()],
          BreakerTripEvent: noTrips,
        },
        isLoading: false,
        error: new Error("Hasura 503"),
      });
      const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
      expect(html).toContain("MedianDelta"); // last-known strip still renders
      expect(html).toContain("Breaker status refresh failed");
      expect(html).toContain("showing the last confirmed state");
      expect(html).toContain("Hasura 503");
    });

    it("does not render the stale-refresh affordance on the healthy (no-error) path", () => {
      mockUseGQL.mockReturnValue({
        data: {
          BreakerConfig: [healthyMedianConfig()],
          BreakerTripEvent: noTrips,
        },
        isLoading: false,
      });
      const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
      expect(html).not.toContain("refresh failed");
    });
  });

  describe("SSR breaker-config fallback (issue #1237)", () => {
    const fallbackNoBreaker = {
      BreakerConfig: [],
      BreakerTripEvent: noTrips,
    };
    const fallbackWithBreaker = {
      BreakerConfig: [healthyMedianConfig()],
      BreakerTripEvent: noTrips,
    };

    it("forwards initialBreakerConfig to useGQL as fallbackData", () => {
      mockUseGQL.mockReturnValue({
        data: fallbackWithBreaker,
        isLoading: false,
      });
      renderToStaticMarkup(
        <BreakerPanel
          pool={fxPool()}
          initialBreakerConfig={fallbackWithBreaker}
        />,
      );
      // Options object is the 4th positional useGQL argument (index 3);
      // arg[2] stays `refreshMs` per the repo's useGQL call-shape invariant.
      expect(mockUseGQL.mock.calls[0]?.[3]).toMatchObject({
        fallbackData: fallbackWithBreaker,
      });
    });

    it("renders null (not the skeleton) when the SSR fallback resolves to no trip-able breaker while revalidating", () => {
      // SWR keeps `isLoading` true while it revalidates the fallback, but with
      // `data` populated the panel must know its shape on first paint. This is
      // the exact regression #1237 fixes: previously skeleton→null collapse.
      mockUseGQL.mockReturnValue({
        data: fallbackNoBreaker,
        isLoading: true,
      });
      const html = renderToStaticMarkup(
        <BreakerPanel
          pool={fxPool()}
          initialBreakerConfig={fallbackNoBreaker}
        />,
      );
      expect(html).toBe("");
    });

    it("renders the resolved strip (not the skeleton) from the SSR fallback while revalidating", () => {
      mockUseGQL.mockReturnValue({
        data: fallbackWithBreaker,
        isLoading: true,
      });
      const html = renderToStaticMarkup(
        <BreakerPanel
          pool={fxPool()}
          initialBreakerConfig={fallbackWithBreaker}
        />,
      );
      expect(html).toContain("MedianDelta");
      expect(html).toContain("Threshold / Cooldown");
      // No skeleton cell — the resolved shape paints directly.
      expect(html).not.toContain("h-[78px]");
    });
  });

  describe("old-data: stale volatile breaker state (round-1 nit #4, accepted degraded case)", () => {
    it("grows the panel with the reset-path banner once a stale not-tripped fallback revalidates to tripped", () => {
      // POOL_BREAKER_CONFIG can be served from the SSR fallback for up to the
      // 60s unstable_cache revalidate window (pool-detail-ssr.ts). If the
      // breaker trips inside that window, first paint shows the stale
      // not-tripped shape; SWR's client revalidation then resolves to
      // tripped and the panel grows by the ResetPathBanner. This is an
      // accepted, documented old-data tradeoff (round-1 marked it optional),
      // not a bug — this test pins the transition so it doesn't regress
      // silently.
      const notTrippedFallback = {
        BreakerConfig: [healthyMedianConfig()],
        BreakerTripEvent: noTrips,
      };
      mockUseGQL.mockReturnValue({
        data: notTrippedFallback,
        isLoading: true,
      });
      const staleHtml = renderToStaticMarkup(
        <BreakerPanel
          pool={fxPool()}
          initialBreakerConfig={notTrippedFallback}
        />,
      );
      expect(staleHtml).not.toContain("Reset path");

      const trippedRevalidated = {
        BreakerConfig: [trippedMedianConfig()],
        BreakerTripEvent: noTrips,
      };
      mockUseGQL.mockReturnValue({
        data: trippedRevalidated,
        isLoading: false,
      });
      const revalidatedHtml = renderToStaticMarkup(
        <BreakerPanel
          pool={fxPool()}
          initialBreakerConfig={notTrippedFallback}
        />,
      );
      expect(revalidatedHtml).toContain("Reset path");
    });
  });

  describe("hydration safety, cooldown countdown (issue #1237 round 2)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("hydrates a TRIPPED breaker with an active cooldown without a mismatch warning, then settles to the live countdown after the first tick", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-13T08:00:00Z"));
      const trippedConfig = trippedMedianConfig();
      mockUseGQL.mockReturnValue({
        data: { BreakerConfig: [trippedConfig], BreakerTripEvent: noTrips },
        isLoading: false,
      });

      const serverHtml = renderToString(<BreakerPanel pool={fxPool()} />);
      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);
      // Pre-hydration, the server payload shows the state-neutral cooldown
      // placeholder ("—", never "active" or "elapsed" — issue #1257) rather
      // than an exact duration read from the server's wall clock.
      expect(container.innerHTML).not.toContain("cooldown active");
      expect(container.innerHTML).not.toContain("elapsed");
      expect(container.innerHTML).not.toContain("left");
      // Pre-hydration last-trip title is the deterministic UTC-safe value,
      // not the locale-formatted one — a UTC server and the viewer's local
      // tz/locale could otherwise render different `title` text and trip a
      // hydration mismatch (issue #1257 Codex finding).
      const expectedUtcTitle = timestampOrUtc(
        trippedConfig.lastTripAt ?? "",
        null,
      );
      expect(container.innerHTML).toContain(`title="${expectedUtcTitle}"`);

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let root: Root | null = null;
      try {
        act(() => {
          root = hydrateRoot(container, <BreakerPanel pool={fxPool()} />);
        });
        expect(consoleError).not.toHaveBeenCalled();
        // Immediately post-hydration the ticker's first 1s tick hasn't fired
        // yet — `now` is set only from inside the interval callback (never
        // synchronously in the effect body), so the cooldown still renders
        // the neutral placeholder rather than a guessed duration/state.
        expect(container.innerHTML).not.toContain("elapsed");
        expect(container.innerHTML).not.toContain("left");
        // The last-trip title, by contrast, is driven by `useNowSeconds()`
        // (`useSyncExternalStore`), which resolves synchronously on mount —
        // no tick needed — so it's already the real locale-formatted value.
        const expectedLocalTitle = formatTimestamp(
          trippedConfig.lastTripAt ?? "",
        );
        expect(container.innerHTML).toContain(`title="${expectedLocalTitle}"`);

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        // After the first tick, the countdown renders its real duration.
        expect(container.innerHTML).toContain("left");
        expect(container.innerHTML).not.toContain("cooldown active");
        expect(container.innerHTML).not.toContain("elapsed");
      } finally {
        consoleError.mockRestore();
        if (root) {
          act(() => {
            (root as Root).unmount();
          });
        }
        document.body.removeChild(container);
      }
    });

    it("hydrates a TRIPPED breaker whose cooldown already elapsed as the neutral placeholder — not a false 'active' or premature 'elapsed' state — then resolves to elapsed after the first tick (Cursor finding, issue #1257)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-13T08:00:00Z"));
      const elapsedConfig = {
        ...trippedMedianConfig(),
        // Cooldown ended 5 minutes before the frozen "now" — the breaker is
        // actually awaiting reset (rate-in-band check), NOT still cooling
        // down. `cooldownRemainingSecFrom` can't tell this apart from a
        // still-active cooldown until `now` resolves post-mount.
        cooldownEndsAt: String(Math.floor(Date.now() / 1000) - 300),
      };
      mockUseGQL.mockReturnValue({
        data: { BreakerConfig: [elapsedConfig], BreakerTripEvent: noTrips },
        isLoading: false,
      });

      const serverHtml = renderToString(<BreakerPanel pool={fxPool()} />);
      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);
      // Pre-hydration: `now` is unset, so the render must not assert either
      // state for a cooldown that's actually already elapsed — only the
      // neutral placeholder.
      expect(container.innerHTML).not.toContain("cooldown active");
      expect(container.innerHTML).not.toContain("elapsed");
      expect(container.innerHTML).not.toContain("left");

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let root: Root | null = null;
      try {
        act(() => {
          root = hydrateRoot(container, <BreakerPanel pool={fxPool()} />);
        });
        expect(consoleError).not.toHaveBeenCalled();
        // Still pending immediately post-hydration — the cooldown `now`
        // only updates from inside the 1s interval callback.
        expect(container.innerHTML).not.toContain("elapsed");
        expect(container.innerHTML).not.toContain("left");

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        // After the first tick, the reset-path banner correctly resolves to
        // "elapsed" (✓) — the bug this test pins: it must not render "✗ …
        // cooldown active" for a cooldown that has actually already
        // elapsed.
        expect(container.innerHTML).toContain("elapsed");
        expect(container.innerHTML).not.toContain("cooldown active");
        expect(container.innerHTML).not.toContain("left");
      } finally {
        consoleError.mockRestore();
        if (root) {
          act(() => {
            (root as Root).unmount();
          });
        }
        document.body.removeChild(container);
      }
    });

    it("reserves the trips-today suffix pre-hydration for a pool tripped since UTC midnight, so the '· N today' segment is stable across hydration and can't grow/wrap the header (Codex finding, issue #1257)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-13T08:00:00Z"));
      const todayMidnightSec =
        Math.floor(Math.floor(Date.now() / 1000) / 86400) * 86400;
      const trippedToday: BreakerTripEvent = {
        id: "trip-today",
        // 01:00 UTC on the frozen day — after this UTC midnight.
        blockTimestamp: String(todayMidnightSec + 3600),
        txHash: "0xtriptoday",
        medianRateAtTrip: "1230000000000000000000000",
        referenceAtTrip: "1171560280196965000000000",
        thresholdAtTrip: "40000000000000000000000",
        // Same address as healthy/trippedMedianConfig's breaker.
        breaker: {
          address: "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9",
          kind: "MEDIAN_DELTA",
        },
      };
      mockUseGQL.mockReturnValue({
        data: {
          BreakerConfig: [trippedMedianConfig()],
          BreakerTripEvent: [trippedToday],
        },
        isLoading: false,
      });

      const serverHtml = renderToString(<BreakerPanel pool={fxPool()} />);
      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);
      // Pre-hydration (clock pending): the today-suffix segment is RESERVED
      // (present) with the neutral placeholder, not dropped — so the segment
      // doesn't pop in after mount. The real count is not shown yet.
      expect(container.innerHTML).toContain("today");
      expect(container.innerHTML).not.toContain("1 today");

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let root: Root | null = null;
      try {
        act(() => {
          root = hydrateRoot(container, <BreakerPanel pool={fxPool()} />);
        });
        // No hydration mismatch — server + hydration render both show the
        // reserved placeholder (clock pending on both).
        expect(consoleError).not.toHaveBeenCalled();
        // `useNowSeconds` resolves synchronously on mount (useSyncExternal
        // store), so the placeholder settles to the real count — the segment
        // was present the whole time (no width-growing pop-in).
        expect(container.innerHTML).toContain("1 today");
      } finally {
        consoleError.mockRestore();
        if (root) {
          act(() => {
            (root as Root).unmount();
          });
        }
        document.body.removeChild(container);
      }
    });
  });
});
