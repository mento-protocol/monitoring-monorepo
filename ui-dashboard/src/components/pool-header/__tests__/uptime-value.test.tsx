import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";

type RollupRow = {
  cumulativeBreachSeconds?: string;
  cumulativeCriticalSeconds?: string;
  breachCount?: number;
  deviationBreachStartedAt?: string;
};

type GqlResult = {
  data?: { Pool: RollupRow[] };
  error?: Error;
  isLoading?: boolean;
};

const mockUseGQL = vi.fn<() => GqlResult>(() => ({ data: undefined }));

vi.mock("@/lib/graphql", () => ({
  useGQL: () => mockUseGQL(),
}));

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

describe("UptimeValue", () => {
  it("renders N/A when healthTotalSeconds is missing or zero", () => {
    mockUseGQL.mockReturnValueOnce({ data: { Pool: [] } });
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders N/A (not 'Query failed') when the rollup query errors out — indexer hasn't redeployed yet", () => {
    // Graceful-degradation contract: the new fields won't exist until the
    // indexer deploy lands, so 'Query failed' would cry wolf. N/A is the
    // honest answer for "can't tell yet."
    mockUseGQL.mockReturnValueOnce({ error: new Error("field not found") });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("Query failed");
  });

  it("renders 100.000% with 'no breaches' when the rollup says nothing critical has happened", () => {
    mockUseGQL.mockReturnValueOnce({
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
    expect(html).toContain("100.000%");
    expect(html).toContain("no breaches");
  });

  it("formats the critical ratio with three decimals so short outages stay visible", () => {
    // 3600s / (30 × 86400) ≈ 0.139% downtime → 99.861% uptime. Three
    // decimals are deliberate: 1dp would smooth this into 99.9% and hide
    // a real outage.
    mockUseGQL.mockReturnValueOnce({
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
    expect(html).toContain("99.861%");
    expect(html).toContain("2 breaches");
  });

  it("pluralises the breach-count label correctly", () => {
    mockUseGQL.mockReturnValueOnce({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "100",
            breachCount: 1,
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(10 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("1 breach");
    expect(html).not.toContain("1 breaches");
  });

  it("adds the live post-grace portion of an active breach to the rollup total", () => {
    // Rollup is 0 (no closed breaches yet), but an active breach started
    // 2h ago. One hour sits in grace, the second hour is critical →
    // uptime reflects that. deviationBreachStartedAt is read from the
    // rollup query itself so it snapshots together with the rolled
    // scalars — not a stale prop.
    const nowSec = Math.floor(Date.now() / 1000);
    mockUseGQL.mockReturnValueOnce({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
            deviationBreachStartedAt: String(nowSec - 2 * 3600),
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("99.861%");
    expect(html).toContain("1 ongoing breach");
  });

  it("does not credit an active breach that is still within the 1h grace window", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockUseGQL.mockReturnValueOnce({
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
    expect(html).toContain("100.000%");
    expect(html).toContain("1 ongoing breach");
  });

  it("labels 'N past + 1 ongoing' when closed history AND an open breach coexist", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockUseGQL.mockReturnValueOnce({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "3600",
            breachCount: 2,
            deviationBreachStartedAt: String(nowSec - 2 * 3600),
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("2 past + 1 ongoing");
  });

  it("snapshots openStart from the rollup query, not the Pool prop — no cache-stale double-count", () => {
    // Guards the invariant the whole fix was for: the tile reads
    // deviationBreachStartedAt from rollup.Pool[0], NOT from the pool
    // prop. If a just-closed breach left a stale prop with a non-zero
    // anchor, the rollup already has 0, so no phantom open-breach time
    // is added. Here we simulate that mismatch: prop says "open", rollup
    // says "closed".
    const nowSec = Math.floor(Date.now() / 1000);
    mockUseGQL.mockReturnValueOnce({
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
    // 3600 / (30 × 86400) ≈ 0.139% → 99.861% (NOT 99.722%, which would
    // be the double-count).
    expect(html).toContain("99.861%");
    expect(html).toContain("1 breach"); // closed, not "1 ongoing"
  });

  it("scales accurately past the 100-row breach-history cap — rolls from scalar, not breach list", () => {
    // A pool with 500 historical breaches. The rollup scalar captures all
    // 500, so the tile reports the correct SLO even though the
    // POOL_DEVIATION_BREACHES query (used by the history panel) would
    // truncate at 100.
    mockUseGQL.mockReturnValueOnce({
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
    // 500h / (10y × 365d × 86400s) ≈ 0.571% downtime → 99.429% uptime.
    expect(html).toContain("99.429%");
    expect(html).toContain("500 breaches");
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
    mockUseGQL.mockReturnValueOnce({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
            deviationBreachStartedAt: String(fri20Utc),
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      // 30d of tracked trading-time. 3600s / (30*86400) ≈ 0.139% → 99.861%.
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("99.861%");
    vi.useRealTimers();
  });

  it("renders N/A on a virtual pool even when called directly (defensive guard)", () => {
    // The parent page already wraps the tile in an isVirtual guard, but
    // the component guards on its own so a test / other caller can't
    // produce a misleading "100% — no breaches" rendering on a pool with
    // no oracle. Also confirms the rollup query is skipped — mockUseGQL
    // isn't asserted here because the component short-circuits before
    // reading its return.
    mockUseGQL.mockReturnValueOnce({ data: undefined });
    const pool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool_factory",
      healthTotalSeconds: String(86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("100.000%");
    expect(html).not.toContain("no breaches");
  });

  it("renders N/A while the rollup query is still loading (no 100% flash)", () => {
    // SWR returns data=undefined before the query resolves. Without a
    // gate, the zero-defaults below would render "100.000% — no
    // breaches" for a blink on every page load — a misleading flash
    // of healthy content for pools that might have real incidents.
    mockUseGQL.mockReturnValueOnce({ data: undefined });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("100.000%");
    expect(html).not.toContain("no breaches");
  });
});
