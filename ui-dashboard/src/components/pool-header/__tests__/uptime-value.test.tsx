import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";

type RollupRow = {
  healthBinarySeconds?: string;
  healthTotalSeconds?: string;
};

type RollupResult = {
  data?: { Pool: RollupRow[] };
  error?: Error;
  isLoading?: boolean;
};

let nextRollup: RollupResult = { data: undefined };

vi.mock("@/lib/graphql", () => ({
  useGQL: (query: string | null) => {
    if (query == null) return { data: undefined };
    if (query.includes("PoolBreachRollup")) return nextRollup;
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
  nextRollup = { data: undefined };
});

describe("UptimeValue", () => {
  it("renders N/A when healthTotalSeconds is missing or zero", () => {
    nextRollup = { data: { Pool: [{ healthBinarySeconds: "0" }] } };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders N/A when healthTotalSeconds is explicitly zero in the rollup row", () => {
    nextRollup = {
      data: {
        Pool: [{ healthBinarySeconds: "0", healthTotalSeconds: "0" }],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders N/A (not 'Query failed') when the rollup query errors out — indexer hasn't redeployed yet", () => {
    nextRollup = { error: new Error("field not found") };
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("Query failed");
  });

  it("renders 100.00% when the indexer's binary counter matches total observation seconds", () => {
    const total = 30 * 86400;
    nextRollup = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(total),
            healthTotalSeconds: String(total),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("100.00%");
  });

  it("formats the ratio with two decimals so short outages stay visible", () => {
    // 1h unhealthy in 30d → 99.86%. Two decimals are deliberate: 1dp
    // would smooth this into 99.9% and hide a real outage.
    const total = 30 * 86400;
    const binary = total - 3600;
    nextRollup = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(binary),
            healthTotalSeconds: String(total),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("99.86%");
  });

  it("clamps to [0, 100] when binary > total (defensive — shouldn't happen, but rounding could push it)", () => {
    const total = 86400;
    nextRollup = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(total + 1),
            healthTotalSeconds: String(total),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("100.00%");
  });

  it("reads healthTotalSeconds from the rollup, not the pool prop, so the numerator/denominator pair is a same-query snapshot", () => {
    // Stale pool prop says "30d of trading time"; rollup row says "60d".
    // The pair must come from the rollup so a torn read across two
    // queries can't briefly push pct over 100% (or under it).
    const rollupTotal = 60 * 86400;
    const rollupBinary = rollupTotal - 3600;
    nextRollup = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(rollupBinary),
            healthTotalSeconds: String(rollupTotal),
          },
        ],
      },
    };
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    // 1h unhealthy in 60d → 99.93%, NOT 99.86% (which is what the
    // stale 30d pool prop would have produced).
    expect(html).toContain("99.93%");
  });

  it("renders N/A when the rollup row is missing healthBinarySeconds (resync window — field not yet populated)", () => {
    nextRollup = { data: { Pool: [{}] } };
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
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
    // SWR returns data=undefined before the query resolves. Without a
    // gate, the zero-defaults below would render "100.00%" for a blink
    // on every page load — a misleading flash of healthy content for
    // pools that might have real incidents.
    nextRollup = { data: undefined };
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("100.00%");
  });
});
