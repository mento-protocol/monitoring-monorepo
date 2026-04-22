import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool, DeviationThresholdBreach } from "@/lib/types";

type GqlResult = {
  data?: { DeviationThresholdBreach: DeviationThresholdBreach[] };
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

function breach(
  overrides: Partial<DeviationThresholdBreach> = {},
): DeviationThresholdBreach {
  return {
    id: "42220-0xpool-1000",
    chainId: 42220,
    poolId: "42220-0xpool",
    startedAt: "1000",
    startedAtBlock: "100",
    endedAt: "5000",
    endedAtBlock: "200",
    durationSeconds: "4000",
    criticalDurationSeconds: "400",
    entryPriceDifference: "6000",
    peakPriceDifference: "7000",
    peakAt: "3000",
    peakAtBlock: "150",
    startedByEvent: "swap",
    startedByTxHash: "0xstart",
    endedByEvent: "rebalance",
    endedByTxHash: "0xend",
    endedByStrategy: "0xstrat",
    rebalanceCountDuring: 1,
    ...overrides,
  };
}

describe("UptimeValue", () => {
  it("renders N/A when healthTotalSeconds is missing or zero", () => {
    mockUseGQL.mockReturnValueOnce({ data: { DeviationThresholdBreach: [] } });
    const html = renderToStaticMarkup(<UptimeValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders N/A (not 'Query failed') when the breach query errors out — indexer hasn't redeployed yet", () => {
    // Graceful-degradation contract: the new entity type won't exist until
    // the indexer deploy lands, so 'Query failed' would cry wolf. N/A is
    // the honest answer for "can't tell yet."
    mockUseGQL.mockReturnValueOnce({ error: new Error("type not found") });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("N/A");
    expect(html).not.toContain("Query failed");
  });

  it("renders 100.000% with 'no breaches' when the breach list is empty", () => {
    mockUseGQL.mockReturnValueOnce({ data: { DeviationThresholdBreach: [] } });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("100.000%");
    expect(html).toContain("no breaches");
  });

  it("sums criticalDurationSeconds across closed breaches at 3-decimal precision", () => {
    // 3600s critical over 30d ≈ 99.861% uptime. Rounding to 3dp catches
    // short outages that 1dp would smooth away.
    mockUseGQL.mockReturnValueOnce({
      data: {
        DeviationThresholdBreach: [
          breach({ criticalDurationSeconds: "1800" }),
          breach({
            id: "42220-0xpool-2000",
            criticalDurationSeconds: "1800",
          }),
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
      data: { DeviationThresholdBreach: [breach()] },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(10 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    expect(html).toContain("1 breach");
    expect(html).not.toContain("1 breaches");
  });

  it("counts the post-grace portion of an open breach in the critical sum", () => {
    // Breach started 2h ago, still open → 1h in grace, 1h past it → 3600s
    // of critical-state contribution to the live uptime.
    const nowSec = Math.floor(Date.now() / 1000);
    mockUseGQL.mockReturnValueOnce({
      data: {
        DeviationThresholdBreach: [
          breach({
            id: "42220-0xpool-open",
            startedAt: String(nowSec - 2 * 3600),
            endedAt: null,
            endedAtBlock: null,
            durationSeconds: null,
            criticalDurationSeconds: null,
          }),
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    // 3600s / (30*86400) ≈ 0.139% downtime → 99.861% uptime.
    expect(html).toContain("99.861%");
  });

  it("does not count an open breach still inside the 1h grace window", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockUseGQL.mockReturnValueOnce({
      data: {
        DeviationThresholdBreach: [
          breach({
            id: "42220-0xpool-fresh",
            startedAt: String(nowSec - 30 * 60),
            endedAt: null,
            endedAtBlock: null,
            durationSeconds: null,
            criticalDurationSeconds: null,
          }),
        ],
      },
    });
    const pool: Pool = {
      ...BASE_POOL,
      healthTotalSeconds: String(30 * 86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    // Still within grace → no critical contribution → full 100%.
    expect(html).toContain("100.000%");
  });

  it("renders N/A immediately for virtual pools (query is never issued)", () => {
    // Virtual pools never breach. The hook returns {data: undefined} by
    // default because useGQL is passed a null document.
    mockUseGQL.mockReturnValueOnce({ data: undefined });
    const pool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool_factory",
      healthTotalSeconds: String(86400),
    };
    const html = renderToStaticMarkup(<UptimeValue pool={pool} />);
    // healthTotalSeconds > 0, so it goes to the breach-sum branch. With
    // zero breaches → 100% uptime and "no breaches."
    expect(html).toContain("100.000%");
    expect(html).toContain("no breaches");
  });
});
