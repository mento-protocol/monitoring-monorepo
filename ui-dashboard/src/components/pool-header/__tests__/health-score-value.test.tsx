import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";

// Mock useHealthScore — the hook is tested directly in hooks/__tests__/.
const mockUseHealthScore = vi.fn();
vi.mock("@/hooks/use-health-score", () => ({
  useHealthScore: (pool: Pool) => mockUseHealthScore(pool),
}));

import { HealthScoreValue } from "@/components/pool-header/health-score-value";

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

function healthResult(overrides: {
  score?: number | null;
  allTimeScore?: number | null;
  observedHours?: number;
  hasEnoughDataForNines?: boolean;
  error?: Error | null;
}) {
  return {
    health24h: {
      score: overrides.score ?? null,
      trackedSeconds: 0,
      healthySeconds: 0,
      staleSeconds: 0,
      observedHours: overrides.observedHours ?? 0,
      hasEnoughDataForNines: overrides.hasEnoughDataForNines ?? false,
    },
    allTimeScore: overrides.allTimeScore ?? null,
    error: overrides.error ?? null,
  };
}

describe("HealthScoreValue", () => {
  it('renders "Query failed" when the hook surfaces an error', () => {
    mockUseHealthScore.mockReturnValue(
      healthResult({ error: new Error("boom") }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("Query failed");
    expect(html).toContain("text-amber-400");
  });

  it('renders "N/A" when both scores are null', () => {
    mockUseHealthScore.mockReturnValue(
      healthResult({ score: null, allTimeScore: null }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders 24h score and all-time line together with correct formatting", () => {
    mockUseHealthScore.mockReturnValue(
      healthResult({
        score: 0.995,
        allTimeScore: 0.9999,
        hasEnoughDataForNines: true,
      }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("99.50%"); // formatBinaryHealthPct(0.995)
    expect(html).toContain("24h");
    expect(html).toContain("99.99%"); // formatBinaryHealthPct(0.9999)
    expect(html).toContain("all-time");
  });

  it("renders the Nh observed line when hasEnoughDataForNines is false", () => {
    mockUseHealthScore.mockReturnValue(
      healthResult({
        score: 0.98,
        allTimeScore: null,
        observedHours: 6.5,
        hasEnoughDataForNines: false,
      }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("6.5h observed");
  });
});
