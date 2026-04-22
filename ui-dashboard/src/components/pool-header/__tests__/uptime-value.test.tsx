import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";

type RollupRow = {
  cumulativeBreachSeconds?: string;
  cumulativeCriticalSeconds?: string;
  breachCount?: number;
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
    // 2h ago. One hour sits in grace, the second hour is critical → uptime
    // should reflect that.
    const nowSec = Math.floor(Date.now() / 1000);
    mockUseGQL.mockReturnValueOnce({
      data: {
        Pool: [
          {
            cumulativeCriticalSeconds: "0",
            breachCount: 0,
          },
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
      deviationBreachStartedAt: String(nowSec - 2 * 3600),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("99.861%");
  });

  it("does not credit an active breach that is still within the 1h grace window", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockUseGQL.mockReturnValueOnce({
      data: { Pool: [{ cumulativeCriticalSeconds: "0", breachCount: 0 }] },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
      deviationBreachStartedAt: String(nowSec - 30 * 60),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("100.000%");
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

  it("renders N/A on a virtual pool (rollup query skipped)", () => {
    mockUseGQL.mockReturnValueOnce({ data: undefined });
    const pool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool_factory",
      healthTotalSeconds: String(86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    // data is undefined → rollup fields default to 0 → 100% uptime, but
    // the rollup scalar is the authoritative "no breaches" signal.
    expect(html).toContain("100.000%");
    expect(html).toContain("no breaches");
  });
});
