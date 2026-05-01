import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";
import { SECONDS_PER_DAY } from "@/lib/time-series";

type RollupRow = {
  healthBinarySeconds?: string;
  healthTotalSeconds?: string;
};
type DailyAnchorRow = {
  timestamp?: string;
  cumulativeHealthBinarySeconds?: string;
  cumulativeHealthTotalSeconds?: string;
};

type RollupResult = {
  data?: { Pool: RollupRow[] };
  error?: Error;
};
type AnchorResult = {
  data?: { PoolDailySnapshot: DailyAnchorRow[] };
  error?: Error;
};

let nextRollup: RollupResult = { data: undefined };
let nextAnchor: AnchorResult = { data: { PoolDailySnapshot: [] } };
let anchorVars:
  | { id?: string; chainId?: number; sevenDaysAgo?: number }
  | undefined;

vi.mock("@/lib/graphql", () => ({
  useGQL: (
    query: string | null,
    variables?: { id?: string; chainId?: number; sevenDaysAgo?: number },
  ) => {
    if (query == null) return { data: undefined };
    if (query.includes("PoolBreachRollup")) return nextRollup;
    if (query.includes("PoolHealth7dAnchor")) {
      anchorVars = variables;
      return nextAnchor;
    }
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

const noAnchor: AnchorResult = { data: { PoolDailySnapshot: [] } };

beforeEach(() => {
  nextRollup = { data: undefined };
  nextAnchor = noAnchor;
  anchorVars = undefined;
});

// Restore real timers unconditionally so a failed assertion inside a
// useFakeTimers() block doesn't leak frozen time into subsequent tests.
afterEach(() => {
  vi.useRealTimers();
});

describe("UptimeValue", () => {
  it("renders N/A when healthTotalSeconds is missing or zero", () => {
    nextRollup = { data: { Pool: [{ healthBinarySeconds: "0" }] } };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders N/A (not 'Query failed') when the rollup query errors out — indexer hasn't redeployed yet", () => {
    nextRollup = { error: new Error("field not found") };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("Query failed");
  });

  it("renders 100.00% all-time / 100.00% last 7d when nothing has been unhealthy", () => {
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
    nextAnchor = {
      data: {
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

  it("computes 7d uptime from the daily-snapshot anchor and shows '↑' when 7d > all-time", () => {
    // All-time: 100h unhealthy in 30d → ~99.86%.
    // 7d window: 0h unhealthy → 100.00% → ↑ vs all-time.
    const totalAll = 30 * 86400;
    const binaryAll = totalAll - 100 * 3600;
    nextRollup = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(binaryAll),
            healthTotalSeconds: String(totalAll),
          },
        ],
      },
    };
    nextAnchor = {
      data: {
        PoolDailySnapshot: [
          {
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
    const totalAll = 30 * 86400;
    const binaryAll = totalAll;
    const anchorTotal = totalAll - 7 * 86400;
    const anchorBinary = anchorTotal;
    nextRollup = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(binaryAll - 3600),
            healthTotalSeconds: String(totalAll),
          },
        ],
      },
    };
    nextAnchor = {
      data: {
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

  it("falls back to '—' when the daily-snapshot anchor is older than ~8 days (silent pool)", () => {
    // A pool that's been totally inactive for 30+ days has no recent
    // PoolDailySnapshot rows. The query picks up an ancient one, but
    // labelling that "% last 7d" would lie about the actual window. The
    // freshness gate in computeWindowUptimePct rejects anchors >8d old.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
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
    nextAnchor = {
      data: {
        PoolDailySnapshot: [
          {
            timestamp: String(nowSec - 30 * 86400),
            cumulativeHealthBinarySeconds: String(total - 7 * 86400),
            cumulativeHealthTotalSeconds: String(total - 7 * 86400),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("100.00%");
    expect(html).toContain("—");
    expect(html).not.toMatch(/last 7d/);
  });

  it("falls back to '—' for the 7d subtitle when no daily-snapshot anchor exists (pool too young)", () => {
    nextRollup = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(86400),
            healthTotalSeconds: String(86400),
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("100.00%");
    expect(html).toContain("—");
    expect(html).not.toMatch(/last 7d/);
  });

  it("scopes the 7d anchor query by chainId and the day-bucketed cutoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T21:01:00Z"));
    nextRollup = {
      data: {
        Pool: [
          {
            healthBinarySeconds: String(86400),
            healthTotalSeconds: String(86400),
          },
        ],
      },
    };

    renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);

    const todayStart =
      Math.floor(Date.parse("2026-04-30T21:01:00Z") / 1000 / SECONDS_PER_DAY) *
      SECONDS_PER_DAY;
    expect(anchorVars).toEqual({
      id: BASE_POOL.id,
      chainId: BASE_POOL.chainId,
      sevenDaysAgo: todayStart - 7 * SECONDS_PER_DAY,
    });
  });

  it("keeps the all-time line rendered when ONLY the 7d-anchor query fails (schema-lag isolation)", () => {
    // The anchor query targets the new `cumulativeHealth*` fields, which
    // the schema-rollout window can reject with "field not found". The
    // all-time rollup must keep rendering — only the subtitle degrades.
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
    nextAnchor = { error: new Error("field not found") };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("99.86%");
    expect(html).toContain("—");
    expect(html).not.toMatch(/last 7d/);
  });

  it("suppresses the trend arrow when all-time and 7d round to the same 2-decimal value", () => {
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
    nextAnchor = {
      data: {
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
    nextRollup = { data: undefined };
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("100.00%");
  });
});
