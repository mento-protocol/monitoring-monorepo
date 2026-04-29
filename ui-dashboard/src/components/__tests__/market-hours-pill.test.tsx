import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketHoursPill } from "@/components/market-hours-pill";
import type { Pool } from "@/lib/types";

// Mock the GraphQL hook so we can drive `enabled` from breaker config.
const mockUseGQL = vi.fn();
vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
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

describe("MarketHoursPill", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
  });

  afterEach(() => {
    globalThis.Date = originalDate;
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

  it("renders nothing when the MARKET_HOURS BreakerConfig is disabled", () => {
    // Governance can disable the market-hours breaker for a feed via
    // BreakerStatusUpdated(..., false). The pill must hide in that case so
    // the dashboard doesn't show a "Market Open/Closed" gate that no longer
    // reflects the on-chain trading mode.
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [{ enabled: false, breaker: { kind: "MARKET_HOURS" } }],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-04-29T12:00:00Z");
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).toBe("");
  });

  it("renders schedule mode when market is open and >6h until close (Wed noon)", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [{ enabled: true, breaker: { kind: "MARKET_HOURS" } }],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-04-29T12:00:00Z"); // Wednesday noon
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).toContain("Market Open");
    expect(html).toContain("Sun 23:00");
    expect(html).toContain("Fri 21:00 UTC");
    // Schedule mode uses emerald label, NOT amber.
    expect(html).toContain("text-emerald-300");
    expect(html).not.toContain("text-amber-300");
  });

  it("renders amber countdown mode when <6h until close (Fri 17:00)", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [{ enabled: true, breaker: { kind: "MARKET_HOURS" } }],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-05-01T17:00:00Z"); // Friday 17:00 — 4h until 21:00 close
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).toContain("Market Open");
    expect(html).toContain("until close");
    expect(html).toContain("text-amber-300");
    expect(html).toContain("bg-amber-900/40");
  });

  it("renders Market Closed countdown to reopen on Saturday", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [{ enabled: true, breaker: { kind: "MARKET_HOURS" } }],
        BreakerTripEvent: [],
      },
    });
    freezeNow("2026-05-02T12:00:00Z"); // Saturday noon
    const html = renderToStaticMarkup(<MarketHoursPill pool={fxPool()} />);
    expect(html).toContain("Market Closed");
    expect(html).toContain("until open");
    // Closed-state is neutral slate, not amber.
    expect(html).toContain("text-slate-300");
    expect(html).not.toContain("text-amber-300");
  });
});
