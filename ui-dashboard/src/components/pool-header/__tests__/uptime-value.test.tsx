import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";

type RollupRow = {
  cumulativeBreachSeconds?: string;
  cumulativeCriticalSeconds?: string;
  breachCount?: number;
  deviationBreachStartedAt?: string;
  currentOpenBreachPeak?: string;
  currentOpenBreachEntryThreshold?: number;
};

type RecentBreachRow = {
  criticalDurationSeconds?: string | number;
  startedAt?: string;
  endedAt?: string;
};

type RollupResult = {
  data?: { Pool: RollupRow[] };
  error?: Error;
  isLoading?: boolean;
};
type RecentResult = {
  data?: { DeviationThresholdBreach: RecentBreachRow[] };
  error?: Error;
  isLoading?: boolean;
};

// The component fires two useGQL calls per render: rollup first, then
// recent-breaches. Route by query string so a test can configure either
// independently without depending on call order.
let nextRollup: RollupResult = { data: undefined };
let nextRecent: RecentResult = {
  data: { DeviationThresholdBreach: [] },
};

vi.mock("@/lib/graphql", () => ({
  useGQL: (query: string | null) => {
    if (query == null) return { data: undefined };
    if (query.includes("PoolBreachRollup")) return nextRollup;
    if (query.includes("PoolCriticalSecondsRecent")) return nextRecent;
    return { data: undefined };
  },
}));

// 7d-window tests pin the system clock to a calendar-deterministic
// Tuesday so `tradingSecondsInRange` lands on a known weekend pattern
// (one full Sat-Sun closure inside the 7d window → 50h closed).
//   trading_7d = 7×86400 − 50×3600 = 424,800 seconds
//   1 hour critical → 1 − 3600/424800 = 99.15% uptime
const FIXED_TUE_NOON_UTC = "2024-01-09T12:00:00Z";

import { UptimeValue } from "@/components/pool-header/uptime-value";

const BASE_POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
};

function setRollup(r: RollupResult) {
  nextRollup = r;
}
function setRecent(r: RecentResult) {
  nextRecent = r;
}

// Reset between tests so a stale mock doesn't leak across cases.
beforeEachReset();
function beforeEachReset() {
  // vitest's beforeEach is registered at module load via top-level call below
}
import { beforeEach } from "vitest";
beforeEach(() => {
  nextRollup = { data: undefined };
  nextRecent = { data: { DeviationThresholdBreach: [] } };
});

describe("UptimeValue", () => {
  it("renders N/A when healthTotalSeconds is missing or zero", () => {
    setRollup({ data: { Pool: [] } });
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders N/A (not 'Query failed') when the rollup query errors out — indexer hasn't redeployed yet", () => {
    setRollup({ error: new Error("field not found") });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("Query failed");
  });

  it("renders 100.00% all-time / 100.00% last 7d when nothing critical has happened", () => {
    setRollup({
      data: {
        Pool: [
          {
            cumulativeBreachSeconds: "0",
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("100.00%");
    expect(html).toMatch(/100\.00% last 7d/);
  });

  it("formats the all-time critical ratio with two decimals so short outages stay visible", () => {
    // 3600s / (30 × 86400) ≈ 0.139% downtime → 99.86% uptime. Two
    // decimals are deliberate: 1dp would smooth this into 99.9% and hide
    // a real outage.
    setRollup({
      data: {
        Pool: [
          {
            cumulativeBreachSeconds: "7200",
            cumulativeCriticalSeconds: "3600",
            breachCount: 2,
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("99.86%");
  });

  it("pro-rates a closed breach that mostly happened before the 7d window — does not over-count", () => {
    // Scenario from a real Monad pool: a 5-day breach that ended 9 days
    // ago has `criticalDurationSeconds` larger than the 7d window's
    // trading-seconds. Counting it whole pushed the 7d numerator past
    // the denominator and clamped the tile to 0% on a pool that's
    // currently fine. The clip prorates the contribution by how much of
    // the breach's wall-clock duration overlapped the window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TUE_NOON_UTC));
    const nowSec = Math.floor(Date.now() / 1000);
    const breachEnd = nowSec - 9 * 86400; // ended 9d ago — ENTIRELY outside the 7d window
    const breachStart = breachEnd - 5 * 86400;
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: String(5 * 86400),
            breachCount: 1,
          },
        ],
      },
    });
    setRecent({
      data: {
        DeviationThresholdBreach: [
          {
            criticalDurationSeconds: String(5 * 86400),
            startedAt: String(breachStart),
            endedAt: String(breachEnd),
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(15 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    // Breach ended 9d ago, window starts 7d ago → overlap=0 → 100% last 7d.
    expect(html).toMatch(/100\.00% last 7d/);
    vi.useRealTimers();
  });

  it("renders an emerald ↑ arrow when 7d uptime is better than all-time", () => {
    // Lots of historical critical seconds → low all-time uptime; clean
    // 7d window → 100% last 7d. Trend should read "up" in emerald.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TUE_NOON_UTC));
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: String(10 * 3600),
            breachCount: 5,
          },
        ],
      },
    });
    setRecent({ data: { DeviationThresholdBreach: [] } });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("↑");
    expect(html).toContain("text-emerald-400");
    expect(html).toContain('aria-label="trending up vs all-time"');
    expect(html).not.toContain("↓");
    vi.useRealTimers();
  });

  it("renders a red ↓ arrow when 7d uptime is worse than all-time", () => {
    // Open breach in the 7d window pushes recent uptime below the
    // pristine all-time number. Trend should read "down" in red.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TUE_NOON_UTC));
    const nowSec = Math.floor(Date.now() / 1000);
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
            deviationBreachStartedAt: String(nowSec - 2 * 3600),
            currentOpenBreachPeak: "8000",
            currentOpenBreachEntryThreshold: 5000,
          },
        ],
      },
    });
    setRecent({ data: { DeviationThresholdBreach: [] } });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("↓");
    expect(html).toContain("text-red-400");
    expect(html).toContain('aria-label="trending down vs all-time"');
    expect(html).not.toContain("↑");
    vi.useRealTimers();
  });

  it("suppresses the arrow when all-time and 7d round to the same 2-decimal value", () => {
    // Identical uptime in both windows → no trend signal worth showing.
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
          },
        ],
      },
    });
    setRecent({ data: { DeviationThresholdBreach: [] } });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).not.toContain("↑");
    expect(html).not.toContain("↓");
  });

  it("subtracts closed-breach critical seconds from the 7d window (FX-weekend math)", () => {
    // 1h critical / 424,800 trading seconds ≈ 0.847% → 99.15%
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TUE_NOON_UTC));
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "3600",
            breachCount: 1,
          },
        ],
      },
    });
    const breachEnd = Math.floor(Date.now() / 1000) - 1 * 86400;
    setRecent({
      data: {
        DeviationThresholdBreach: [
          {
            criticalDurationSeconds: "3600",
            startedAt: String(breachEnd - 3600),
            endedAt: String(breachEnd),
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toMatch(/99\.15% last 7d/);
    vi.useRealTimers();
  });

  it("shows 100.00% last 7d when no breaches landed in the window even if all-time uptime is degraded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TUE_NOON_UTC));
    setRollup({
      data: {
        Pool: [
          {
            // historical critical seconds (older than 7d) — drops all-time uptime,
            cumulativeCriticalSeconds: String(10 * 3600),
            breachCount: 5,
          },
        ],
      },
    });
    // …but the 7d window has nothing.
    setRecent({ data: { DeviationThresholdBreach: [] } });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toMatch(/100\.00% last 7d/);
    vi.useRealTimers();
  });

  it("falls back to '—' for the 7d subtitle when the recent-breach query is still loading", () => {
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
          },
        ],
      },
    });
    // recent: undefined data simulates the in-flight state.
    setRecent({ data: undefined });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("100.00%");
    expect(html).toContain("—");
    expect(html).not.toMatch(/last 7d/);
  });

  it("adds the live post-grace portion of an active breach to the all-time AND 7d totals", () => {
    // Open breach 2h ago → 1h grace + 1h critical. 30d denominator: 99.86%
    // all-time. 7d denominator: 1h / 424,800 trading-seconds ≈ 0.847% → 99.15%.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TUE_NOON_UTC));
    const nowSec = Math.floor(Date.now() / 1000);
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
            deviationBreachStartedAt: String(nowSec - 2 * 3600),
            currentOpenBreachPeak: "8000", // 1.6x — well above critical magnitude
            currentOpenBreachEntryThreshold: 5000,
          },
        ],
      },
    });
    setRecent({ data: { DeviationThresholdBreach: [] } });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("99.86%");
    expect(html).toMatch(/99\.15% last 7d/);
    vi.useRealTimers();
  });

  it("does not credit an active breach that is still within the 1h grace window", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
            deviationBreachStartedAt: String(nowSec - 30 * 60),
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("100.00%");
    expect(html).toMatch(/100\.00% last 7d/);
  });

  it("snapshots openStart from the rollup query, not the Pool prop — no cache-stale double-count", () => {
    // Guards the invariant the whole fix was for: the tile reads
    // deviationBreachStartedAt from rollup.Pool[0], NOT from the pool
    // prop. If a just-closed breach left a stale prop with a non-zero
    // anchor, the rollup already has 0, so no phantom open-breach time
    // is added. Here we simulate that mismatch: prop says "open", rollup
    // says "closed".
    const nowSec = Math.floor(Date.now() / 1000);
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "3600", // the breach just closed
            breachCount: 1,
            deviationBreachStartedAt: "0", // rollup says closed
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
      // Stale prop: still looks open. Must be ignored.
      deviationBreachStartedAt: String(nowSec - 2 * 3600),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    // 3600 / (30 × 86400) ≈ 0.139% → 99.86% (NOT 99.722%, the double-count).
    expect(html).toContain("99.86%");
  });

  it("scales the all-time number accurately past the breach-history row cap", () => {
    // A pool with 500 historical breaches. The rollup scalar captures all
    // 500, so the tile reports the correct SLO even though the breach-list
    // queries used by the history panel are capped at ENVIO_MAX_ROWS.
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: String(500 * 3600),
            breachCount: 500,
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      // 10 years of tracked trading time to keep the pct humane.
      healthTotalSeconds: String(10 * 365 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    // 500h / (10y × 365d × 86400s) ≈ 0.571% downtime → 99.43% uptime.
    expect(html).toContain("99.43%");
  });

  it("computes the live open-breach portion in trading-seconds, not wall-clock", () => {
    // An open breach anchored Fri 20:00 UTC (1h before FX close), evaluated
    // at Mon 00:00 UTC. Wall-clock elapsed = 52h. With the old wall-clock
    // math, openCritical = 52h - 1h grace = 51h — wildly inflated. The
    // trading-seconds path subtracts the 50h FX closure, leaving 2h of
    // real trading-time after the grace ended (Fri 21:00 grace-end →
    // coincides with weekend start → only Sun 23:00-Mon 00:00 counts =
    // 1h critical).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-08T00:00:00Z"));
    const fri20Utc = Math.floor(
      new Date("2024-01-05T20:00:00Z").getTime() / 1000,
    );
    setRollup({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
            deviationBreachStartedAt: String(fri20Utc),
            // Peak above critical magnitude so the live credit gate fires.
            currentOpenBreachPeak: "8000",
            currentOpenBreachEntryThreshold: 5000,
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      // 30d of tracked trading-time. 3600s / (30*86400) ≈ 0.139% → 99.86%.
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("99.86%");
    vi.useRealTimers();
  });

  it("renders N/A on a virtual pool even when called directly (defensive guard)", () => {
    // The parent page already wraps the tile in an isVirtual guard, but
    // the component guards on its own so a test / other caller can't
    // produce a misleading "100% — no breaches" rendering on a pool with
    // no oracle.
    const pool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool_factory",
      healthTotalSeconds: String(86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("100.00%");
  });

  it("renders N/A while the rollup query is still loading (no 100% flash)", () => {
    // SWR returns data=undefined before the query resolves. Without a
    // gate, the zero-defaults below would render "100.00%" for a blink
    // on every page load — a misleading flash of healthy content for
    // pools that might have real incidents.
    setRollup({ data: undefined });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("100.00%");
  });
});
