/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { MarketHoursPill } from "@/components/market-hours-pill";
import type { PoolBreakerConfigResponse } from "@/lib/queries/config";
import { BREAKER_CONFIG_TIMEOUT_MS } from "@/lib/hasura-timeout";
import type { Pool } from "@/lib/types";

// Mock the GraphQL hook so we can drive `enabled` from breaker config.
const mockUseGQL = vi.fn();
vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

const FX_FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";

function marketHoursConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "market-hours",
    enabled: true,
    status: "OK",
    tradingMode: 0,
    breaker: {
      id: "breaker",
      address: "0x0000000000000000000000000000000000000001",
      kind: "MARKET_HOURS",
      activatesTradingMode: 3,
      defaultCooldownTime: "0",
      defaultRateChangeThreshold: "0",
    },
    ...overrides,
  };
}

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

function nonFxPool(): Pool {
  return {
    ...fxPool(),
    referenceRateFeedID: "",
  } as unknown as Pool;
}

const originalDate = Date;

function freezeNow(iso: string) {
  // Vitest's `vi.setSystemTime` is the canonical way, but we need a
  // constructor that responds to `new Date()`. Replace globalThis.Date with
  // a class that defaults to the frozen instant.
  const frozen = new originalDate(iso);
  // @ts-expect-error — reassign for the duration of one test
  globalThis.Date = class extends originalDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(frozen.getTime());
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        super(...(args as [any]));
      }
    }
    static now() {
      return frozen.getTime();
    }
  };
}

// react-dom/client + act is the codebase's established idiom for tests that
// need mounted (post-effect) behavior — see auth-status.test.tsx. Needed here
// because `renderToStaticMarkup` never runs effects, so it can only observe
// the pill's deterministic pre-mount fallback (see the "SSR determinism"
// describe block below), not the real open/closed/countdown state a viewer
// sees once the page has mounted (issue #1237).
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let previousActEnvironment: boolean | undefined;
let mountedContainer: HTMLElement | null = null;
let mountedRoot: Root | null = null;

function mount(el: React.ReactElement): HTMLElement {
  mountedContainer = document.createElement("div");
  document.body.appendChild(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  act(() => {
    mountedRoot?.render(el);
  });
  return mountedContainer;
}

describe("MarketHoursPill", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
    previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    globalThis.Date = originalDate;
    if (mountedRoot) {
      act(() => {
        mountedRoot?.unmount();
      });
    }
    if (mountedContainer?.parentNode) {
      document.body.removeChild(mountedContainer);
    }
    mountedRoot = null;
    mountedContainer = null;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment ?? false;
  });

  it("renders nothing when the pool has no MARKET_HOURS BreakerConfig", () => {
    mockUseGQL.mockReturnValue({
      data: { BreakerConfig: [], BreakerTripEvent: [] },
    });
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).toBe("");
  });

  it("renders nothing for non-FX (no rateFeedID) pools", () => {
    mockUseGQL.mockReturnValue({ data: undefined });
    const html = renderToStaticMarkup(<MarketHoursPill pool={nonFxPool()} />);
    expect(html).toBe("");
  });

  it("renders a same-height shimmer placeholder (not nothing) while the query is loading", () => {
    // Degraded path only (SSR prefetch missed, so no fallbackData): with the
    // query genuinely in flight a null→pill swap here could push the title row
    // onto a second line (issue #1222), so render a same-height shimmer. When
    // the #1237 prefetch supplies fallbackData, `data` is populated on first
    // paint and this shimmer branch is skipped entirely.
    mockUseGQL.mockReturnValue({ data: undefined, isLoading: true });
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).not.toBe("");
    expect(html).toContain("animate-pulse"); // shimmer box
    // Same box metrics as the real pill (text-xs + py-0.5) so the skeleton →
    // pill swap can't shift the header. The width reserver inside is invisible
    // + aria-hidden; no VISIBLE market-state label renders.
    expect(html).toContain("py-0.5");
    expect(html).toContain("text-xs");
    expect(html).not.toContain("Market Open");
    expect(html).not.toContain("Market —");
  });

  it("renders nothing once the query resolves and no MARKET_HOURS config exists (not stuck on the placeholder)", () => {
    mockUseGQL.mockReturnValue({
      data: { BreakerConfig: [], BreakerTripEvent: [] },
      isLoading: false,
    });
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).toBe("");
  });

  it("renders nothing when the MARKET_HOURS BreakerConfig is disabled", () => {
    // Governance can disable the market-hours breaker for a feed via
    // BreakerStatusUpdated(..., false). The pill must hide in that case so
    // the dashboard doesn't show a "Market Open/Closed" gate that no longer
    // reflects the on-chain trading mode.
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [marketHoursConfig({ enabled: false })],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-04-29T12:00:00Z");
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).toBe("");
  });

  it("renders schedule mode, mounted, when market is open and >6h until close (Wed noon)", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [marketHoursConfig()],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-04-29T12:00:00Z"); // Wednesday noon
    const container = mount(<MarketHoursPill pool={fxPool()} />);
    const html = container.innerHTML;
    expect(html).toContain("Market Open");
    expect(html).toContain("Sun 23:00");
    expect(html).toContain("Fri 21:00 UTC");
    // Schedule mode uses emerald label, NOT amber.
    expect(html).toContain("text-emerald-300");
    expect(html).not.toContain("text-amber-300");
  });

  it("renders amber countdown mode, mounted, when <6h until close (Fri 17:00)", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [marketHoursConfig()],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-05-01T17:00:00Z"); // Friday 17:00 — 4h until 21:00 close
    const container = mount(<MarketHoursPill pool={fxPool()} />);
    const html = container.innerHTML;
    expect(html).toContain("Market Open");
    expect(html).toContain("until close");
    expect(html).toContain("text-amber-300");
    expect(html).toContain("bg-amber-900/40");
  });

  it("renders Market Closed countdown to reopen, mounted, on Saturday", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [marketHoursConfig()],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-05-02T12:00:00Z"); // Saturday noon
    const container = mount(<MarketHoursPill pool={fxPool()} />);
    const html = container.innerHTML;
    expect(html).toContain("Market Closed");
    expect(html).toContain("until open");
    // Closed-state is neutral slate, not amber.
    expect(html).toContain("text-slate-300");
    expect(html).not.toContain("text-amber-300");
  });

  it("renders Market Closed on weekday MARKET_HOURS breaker closures", () => {
    // Breaker-driven closure is deterministic from `data` (not `now`), so
    // this one is safe to assert pre-mount too.
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [
          marketHoursConfig({ status: "TRIPPED", tradingMode: 3 }),
        ],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-04-29T12:00:00Z"); // Wednesday noon
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).toContain("Market Closed");
    expect(html).not.toContain("until open");
    expect(html).not.toContain("Market Open");
  });

  it("preserves the reopen countdown, mounted, when a weekend closure also has a breaker trip", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [
          marketHoursConfig({ status: "TRIPPED", tradingMode: 3 }),
        ],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-05-02T12:00:00Z"); // Saturday noon
    const container = mount(<MarketHoursPill pool={fxPool()} />);
    const html = container.innerHTML;
    expect(html).toContain("Market Closed");
    expect(html).toContain("until open");
    expect(html).not.toContain("Market Open");
  });

  describe("SSR determinism (issue #1237, #1257)", () => {
    // These pin the pre-mount render: `renderToStaticMarkup` uses
    // `useSyncExternalStore`'s `getServerSnapshot`, so `useNowSeconds()`
    // resolves to `null` for the whole call — exactly what happens during
    // the real server render AND the client's hydration render. Open/closed is
    // CLOCK-dependent (weekend calendar), so pre-clock it is UNKNOWN and must
    // render a NEUTRAL pill — never a false "Market Open" (issue #1257).
    it("renders the neutral pill (not a false 'Market Open') even when the real clock is minutes from close", () => {
      mockUseGQL.mockReturnValue({
        data: {
          BreakerConfig: [marketHoursConfig()],
          BreakerTripEvent: [],
        },
      });
      freezeNow("2026-05-01T17:00:00Z"); // Friday 17:00 — really 4h from close
      const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
      expect(html).toContain("Market —");
      expect(html).not.toContain("Market Open");
      expect(html).not.toContain("until close");
      expect(html).not.toContain("text-amber-300");
    });

    it("renders the neutral pill (not a false 'Market Open') during a real weekend closure the clock hasn't revealed", () => {
      mockUseGQL.mockReturnValue({
        data: {
          BreakerConfig: [marketHoursConfig()],
          BreakerTripEvent: [],
        },
      });
      freezeNow("2026-05-02T12:00:00Z"); // Saturday noon — really closed
      const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
      expect(html).toContain("Market —");
      expect(html).not.toContain("Market Open");
      // No resolved countdown pre-clock (the schedule text present in markup is
      // the invisible width reserver, not a visible "until open" countdown).
      expect(html).not.toContain("until open");
    });
  });

  describe("hydration safety (issue #1237, #1257)", () => {
    it("shows the neutral pill (NOT 'Market Open') pre-clock for a weekend-closed feed, then resolves to 'Market Closed · <countdown>' with no mismatch (Codex finding 2, issue #1257)", async () => {
      mockUseGQL.mockReturnValue({
        data: {
          BreakerConfig: [marketHoursConfig()],
          BreakerTripEvent: [],
        },
      });
      freezeNow("2026-05-02T12:00:00Z"); // Saturday noon — really closed

      const serverHtml = renderToString(<MarketHoursPill pool={fxPool()} />);
      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);
      // Pre-hydration: open/closed is UNKNOWN (clock unresolved, breaker not
      // tripped) → the NEUTRAL pill, never a false "Market Open" that a viewer
      // actually inside the weekend would see as wrong operator state.
      expect(container.innerHTML).toContain("Market —");
      expect(container.innerHTML).not.toContain("Market Open");

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let root: Root | null = null;
      try {
        await act(async () => {
          root = hydrateRoot(container, <MarketHoursPill pool={fxPool()} />);
          await Promise.resolve();
        });
        expect(consoleError).not.toHaveBeenCalled();
        // Resolves to the real closed state + countdown; the neutral marker is
        // gone. Width is reserved (invisible sample), so this swap doesn't
        // widen/wrap the header.
        expect(container.innerHTML).not.toContain("Market —");
        expect(container.innerHTML).toContain("Market Closed");
        expect(container.innerHTML).toContain("until open");
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

    it("hydrates a breaker-closed pill during a real weekend closure with a neutral countdown placeholder, then settles to the real reopen countdown (Codex finding, issue #1257)", async () => {
      mockUseGQL.mockReturnValue({
        data: {
          BreakerConfig: [
            marketHoursConfig({ status: "TRIPPED", tradingMode: 3 }),
          ],
          BreakerTripEvent: [],
        },
      });
      freezeNow("2026-05-02T12:00:00Z"); // Saturday noon — really closed

      const serverHtml = renderToString(<MarketHoursPill pool={fxPool()} />);
      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);
      // Pre-hydration: `breakerClosed` is known from the SSR-prefetched
      // fallback data (no clock needed), so the pill already shows "Market
      // Closed" — but the reopen ETA needs the clock, so it renders the
      // neutral "—" placeholder, not the real countdown and not omitted
      // (omitting it would shift the pill's width once the real countdown
      // appears post-mount, reintroducing the issue #1222 wrap shift).
      expect(container.innerHTML).toContain("Market Closed");
      expect(container.innerHTML).not.toContain("until open");

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let root: Root | null = null;
      try {
        await act(async () => {
          root = hydrateRoot(container, <MarketHoursPill pool={fxPool()} />);
          await Promise.resolve();
        });
        expect(consoleError).not.toHaveBeenCalled();
        expect(container.innerHTML).toContain("Market Closed");
        expect(container.innerHTML).toContain("until open");
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

    it("keeps the countdown-slot suffix stable across hydration for a weekday breaker closure — no suffix drop / pill-width shift (Codex finding, issue #1257)", async () => {
      // Weekday on-chain closure (governance/holiday): breakerClosed is true
      // but isWeekend(now) is false, so post-clock there is no scheduled
      // reopen countdown. Before the fix the pre-mount render reserved "· —"
      // but the resolved state DROPPED the suffix, shifting the pill width.
      // reserve == keep now: the neutral "· —" stays across hydration.
      mockUseGQL.mockReturnValue({
        data: {
          BreakerConfig: [
            marketHoursConfig({ status: "TRIPPED", tradingMode: 3 }),
          ],
          BreakerTripEvent: [],
        },
      });
      freezeNow("2026-04-29T12:00:00Z"); // Wednesday noon — closed, NOT a weekend

      const serverHtml = renderToString(<MarketHoursPill pool={fxPool()} />);
      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);
      // Pre-hydration: closed with the neutral "·" suffix reserved.
      expect(container.innerHTML).toContain("Market Closed");
      expect(container.innerHTML).toContain("·");
      expect(container.innerHTML).not.toContain("until open");

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let root: Root | null = null;
      try {
        await act(async () => {
          root = hydrateRoot(container, <MarketHoursPill pool={fxPool()} />);
          await Promise.resolve();
        });
        expect(consoleError).not.toHaveBeenCalled();
        // Post-hydration: still a weekday breaker closure (not a weekend), so
        // the suffix slot is KEPT — the "·" segment does not drop and no
        // "until open" countdown appears, so the pill width is unchanged.
        expect(container.innerHTML).toContain("Market Closed");
        expect(container.innerHTML).toContain("·");
        expect(container.innerHTML).not.toContain("until open");
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

  describe("stale market-hours refresh (Codex finding, issue #1257)", () => {
    it("discloses a failed revalidation while showing the last-known pill instead of presenting it as fresh", () => {
      // Shares the POOL_BREAKER_CONFIG SWR key with BreakerPanel: a failed
      // revalidation keeps the last-known pill on screen while SWR sets
      // `error`. Mirror the breaker panel's stale-refresh affordance.
      freezeNow("2026-04-29T12:00:00Z"); // Wednesday — market open
      mockUseGQL.mockReturnValue({
        data: { BreakerConfig: [marketHoursConfig()], BreakerTripEvent: [] },
        isLoading: false,
        error: new Error("Hasura 503"),
      });
      const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
      expect(html).toContain("Market"); // last-known pill still renders
      expect(html).toContain("Market hours refresh failed");
      expect(html).toContain("showing the last confirmed state");
      expect(html).toContain("Hasura 503");
    });

    it("does not render the stale-refresh affordance on the healthy (no-error) path", () => {
      freezeNow("2026-04-29T12:00:00Z");
      mockUseGQL.mockReturnValue({
        data: { BreakerConfig: [marketHoursConfig()], BreakerTripEvent: [] },
        isLoading: false,
      });
      const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
      expect(html).not.toContain("refresh failed");
    });

    it("bounds the revalidation with a timeout so a STALLED fetch becomes an error and surfaces the stale-refresh notice (Codex P1, issue #1257)", () => {
      // The timeout turns AbortSignal.timeout into a rejected fetch → SWR
      // `error` (TimeoutError = DOMException); without it a never-resolving
      // revalidation would leave the stale pill pinned with `error` unset.
      freezeNow("2026-04-29T12:00:00Z");
      mockUseGQL.mockReturnValue({
        data: { BreakerConfig: [marketHoursConfig()], BreakerTripEvent: [] },
        isLoading: false,
        error: new DOMException("signal timed out", "TimeoutError"),
      });
      const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
      expect(html).toContain("Market hours refresh failed");
      expect(html).toContain("showing the last confirmed state");
    });
  });

  describe("SSR breaker-config fallback (issue #1237)", () => {
    // Cast through unknown (same idiom as `as unknown as Pool` above): the
    // MARKET_HOURS fixture is intentionally partial — the pill only reads
    // `.enabled`, `.breaker.kind`, `.status`, and `.tradingMode`.
    const fallbackNonFx = {
      BreakerConfig: [],
      BreakerTripEvent: [],
    } as unknown as PoolBreakerConfigResponse;
    const fallbackFx = {
      BreakerConfig: [marketHoursConfig()],
      BreakerTripEvent: [],
    } as unknown as PoolBreakerConfigResponse;

    it("forwards initialBreakerConfig to useGQL as fallbackData", () => {
      mockUseGQL.mockReturnValue({ data: fallbackFx, isLoading: false });
      freezeNow("2026-04-29T12:00:00Z");
      renderToStaticMarkup(
        <MarketHoursPill pool={fxPool()} initialBreakerConfig={fallbackFx} />,
      );
      // Options object is the 4th positional useGQL argument (index 3);
      // arg[2] stays `refreshMs` per the repo's useGQL call-shape invariant.
      // The timeout must ride alongside fallbackData so a stalled revalidation
      // surfaces as `error` rather than pinning the stale pill (issue #1257).
      expect(mockUseGQL.mock.calls[0]?.[3]).toMatchObject({
        fallbackData: fallbackFx,
        timeoutMs: BREAKER_CONFIG_TIMEOUT_MS,
      });
    });

    it("renders null (not the shimmer) when the SSR fallback resolves to non-FX while revalidating", () => {
      // SWR keeps `isLoading` true while it revalidates the fallback; with
      // `data` populated the pill must know FX-eligibility on first paint. This
      // is the exact regression #1237 fixes: previously shimmer→null flash.
      mockUseGQL.mockReturnValue({ data: fallbackNonFx, isLoading: true });
      const html = renderToStaticMarkup(
        <MarketHoursPill
          pool={fxPool()}
          initialBreakerConfig={fallbackNonFx}
        />,
      );
      expect(html).toBe("");
    });

    it("renders the resolved-shape pill (not the shimmer) from the SSR fallback while revalidating", () => {
      mockUseGQL.mockReturnValue({ data: fallbackFx, isLoading: true });
      freezeNow("2026-04-29T12:00:00Z"); // Wednesday noon
      const html = renderToStaticMarkup(
        <MarketHoursPill pool={fxPool()} initialBreakerConfig={fallbackFx} />,
      );
      // Pre-clock the open/closed state is neutral (Market —), but the pill —
      // not the shimmer — paints directly from the fallback.
      expect(html).toContain("Market —");
      expect(html).not.toContain("animate-pulse");
    });
  });
});
