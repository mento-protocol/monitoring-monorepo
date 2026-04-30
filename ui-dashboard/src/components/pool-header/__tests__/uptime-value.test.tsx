import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";

type RollupRow = {
  healthBinarySeconds?: string;
  healthTotalSeconds?: string;
};
type DailyAnchorRow = {
  cumulativeHealthBinarySeconds?: string;
  cumulativeHealthTotalSeconds?: string;
};

type Result = {
  data?: { Pool: RollupRow[]; PoolDailySnapshot: DailyAnchorRow[] };
  error?: Error;
  isLoading?: boolean;
};

let next: Result = { data: undefined };

vi.mock("@/lib/graphql", () => ({
  useGQL: (query: string | null) => {
    if (query == null) return { data: undefined };
    if (query.includes("PoolBreachRollup")) return next;
    return { data: undefined };
  },
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

beforeEach(() => {
  next = { data: undefined };
});

describe("UptimeValue", () => {
  it("renders N/A when healthTotalSeconds is missing or zero", () => {
    next = {
      data: {
        Pool: [{ healthBinarySeconds: "0" }],
        PoolDailySnapshot: [],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders N/A (not 'Query failed') when the rollup query errors out — indexer hasn't redeployed yet", () => {
    next = { error: new Error("field not found") };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("Query failed");
  });

  it("renders 100.00% all-time / 100.00% last 7d when nothing has been unhealthy", () => {
    const total = 30 * 86400;
    next = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(total),
            healthTotalSeconds: String(total),
          },
        ],
        PoolDailySnapshot: [
          {
            cumulativeHealthBinarySeconds: String(total - 7 * 86400),
            cumulativeHealthTotalSeconds: String(total - 7 * 86400),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("100.00%");
    expect(html).toMatch(/100\.00% last 7d/);
  });

  it("formats the all-time ratio with two decimals so short outages stay visible", () => {
    // 1h unhealthy in 30d → 99.86%. Two decimals are deliberate: 1dp
    // would smooth this into 99.9% and hide a real outage.
    const total = 30 * 86400;
    const binary = total - 3600;
    next = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(binary),
            healthTotalSeconds: String(total),
          },
        ],
        PoolDailySnapshot: [],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("99.86%");
  });

  it("clamps to [0, 100] when binary > total (defensive — shouldn't happen, but rounding could push it)", () => {
    const total = 86400;
    next = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(total + 1),
            healthTotalSeconds: String(total),
          },
        ],
        PoolDailySnapshot: [],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("100.00%");
  });

  it("computes 7d uptime from the daily-snapshot anchor and shows '↑' when 7d > all-time", () => {
    // All-time: 100h unhealthy in 30d → ~99.86%.
    // 7d window: 0h unhealthy → 100.00% → ↑ vs all-time.
    const totalAll = 30 * 86400;
    const binaryAll = totalAll - 100 * 3600;
    next = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(binaryAll),
            healthTotalSeconds: String(totalAll),
          },
        ],
        PoolDailySnapshot: [
          {
            // 7d ago: same gap as today — i.e. the unhealthy time happened
            // BEFORE the anchor. The 7d window has zero unhealthy seconds.
            cumulativeHealthBinarySeconds: String(binaryAll - 7 * 86400),
            cumulativeHealthTotalSeconds: String(totalAll - 7 * 86400),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("↑");
    expect(html).toContain("text-emerald-400");
    expect(html).toMatch(/100\.00% last 7d/);
    expect(html).not.toContain("↓");
  });

  it("shows '↓' in red when 7d < all-time (recent regression)", () => {
    // All-time: clean → 100.00%.
    // 7d window: 1h unhealthy in 7d trading-seconds → ~99.40%.
    const totalAll = 30 * 86400;
    const binaryAll = totalAll;
    const anchorTotal = totalAll - 7 * 86400;
    const anchorBinary = anchorTotal; // clean before window
    // Inject 1h of unhealthy time inside the 7d window — i.e. binary
    // grows by less than total since the anchor.
    next = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(binaryAll - 3600),
            healthTotalSeconds: String(totalAll),
          },
        ],
        PoolDailySnapshot: [
          {
            cumulativeHealthBinarySeconds: String(anchorBinary),
            cumulativeHealthTotalSeconds: String(anchorTotal),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("↓");
    expect(html).toContain("text-red-400");
    expect(html).not.toContain("↑");
  });

  it("falls back to '—' for the 7d subtitle when no daily-snapshot anchor exists (pool too young)", () => {
    next = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(86400),
            healthTotalSeconds: String(86400),
          },
        ],
        PoolDailySnapshot: [],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("100.00%");
    expect(html).toContain("—");
    expect(html).not.toMatch(/last 7d/);
  });

  it("suppresses the trend arrow when all-time and 7d round to the same 2-decimal value", () => {
    const total = 30 * 86400;
    next = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(total),
            healthTotalSeconds: String(total),
          },
        ],
        PoolDailySnapshot: [
          {
            cumulativeHealthBinarySeconds: String(total - 7 * 86400),
            cumulativeHealthTotalSeconds: String(total - 7 * 86400),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).not.toContain("↑");
    expect(html).not.toContain("↓");
  });

  it("renders N/A on a virtual pool even when called directly (defensive guard)", () => {
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
    next = { data: undefined };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("100.00%");
  });
});
