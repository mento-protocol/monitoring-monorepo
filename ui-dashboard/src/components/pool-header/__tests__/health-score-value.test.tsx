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

const NOMINAL_WINDOW_SECONDS = 7 * 24 * 3600;

function healthResult(overrides: {
  score?: number | null;
  allTimeScore?: number | null;
  observedHours?: number;
  trackedSeconds?: number;
  hasEnoughDataForNines?: boolean;
  truncated?: boolean;
  error?: Error | null;
}) {
  return {
    healthWindow: {
      score: overrides.score ?? null,
      trackedSeconds:
        overrides.trackedSeconds ?? (overrides.observedHours ?? 0) * 3600,
      healthySeconds: 0,
      staleSeconds: 0,
      observedHours: overrides.observedHours ?? 0,
      hasEnoughDataForNines: overrides.hasEnoughDataForNines ?? false,
    },
    allTimeScore: overrides.allTimeScore ?? null,
    truncated: overrides.truncated ?? false,
    nominalWindowSeconds: NOMINAL_WINDOW_SECONDS,
    error: overrides.error ?? null,
  };
}

describe("HealthScoreValue", () => {
  it('renders "Query failed" on error when allTimeScore is also null', () => {
    mockUseHealthScore.mockReturnValue(
      healthResult({ error: new Error("boom"), allTimeScore: null }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("Query failed");
    expect(html).toContain("text-amber-400");
  });

  it("keeps the all-time line on error when allTimeScore is still available", () => {
    // allTimeScore is derived from Pool fields directly, not the 24h GQL
    // queries, so a transient window-query failure must not blank it.
    mockUseHealthScore.mockReturnValue(
      healthResult({
        error: new Error("timeout"),
        score: null,
        allTimeScore: 0.87,
      }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    // 24h row degrades to "Query failed" (amber), all-time row stays.
    expect(html).toContain("Query failed");
    expect(html).toContain("text-amber-400");
    expect(html).toContain("87.00%");
    expect(html).toContain("all-time");
  });

  it('renders "N/A" when both scores are null', () => {
    mockUseHealthScore.mockReturnValue(
      healthResult({ score: null, allTimeScore: null }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("N/A");
  });

  it("renders rolling-window score and all-time line together with correct formatting", () => {
    mockUseHealthScore.mockReturnValue(
      healthResult({
        score: 0.995,
        allTimeScore: 0.9999,
        // Full 7d coverage (168h) — label stays "7d".
        observedHours: 168,
        trackedSeconds: NOMINAL_WINDOW_SECONDS,
        hasEnoughDataForNines: true,
      }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("99.50%"); // formatBinaryHealthPct(0.995)
    expect(html).toContain("7d");
    expect(html).toContain("99.99%"); // formatBinaryHealthPct(0.9999)
    expect(html).toContain("all-time");
    // `X nines` shorthand was removed — the raw percentage carries the signal.
    expect(html).not.toMatch(/nines?/);
  });

  it("no longer renders the info icon inside the value (it moved next to the label)", () => {
    // The ⓘ is now rendered by HealthScoreInfoIcon alongside the cell's
    // `<dt>` label in PoolHeader, not inline with the 7d number. Keeps the
    // value line tight and makes the explainer read as "about this metric".
    mockUseHealthScore.mockReturnValue(
      healthResult({
        score: 0.99,
        allTimeScore: 0.98,
        hasEnoughDataForNines: true,
      }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).not.toContain("ⓘ");
    expect(html).not.toContain("cursor-help");
  });

  it("renders hours-unit coverage inline when sub-24h of data has been observed", () => {
    // Sub-24h coverage (young pool) — inline label drops from "7d" to the
    // actual hour count so it can't overstate the window.
    mockUseHealthScore.mockReturnValue(
      healthResult({
        score: 0.98,
        allTimeScore: null,
        observedHours: 6.5,
        hasEnoughDataForNines: false,
      }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("6.5h");
    expect(html).not.toContain(">7d<");
  });

  it("renders days-unit coverage when the window was truncated by the snapshot cap", () => {
    // >1000 snapshots in 7d → normalizeWindowSnapshots truncates and
    // effectiveWindowStart narrows. Label degrades to the actual covered
    // duration so "7d" can't mask a shorter-than-nominal window.
    mockUseHealthScore.mockReturnValue(
      healthResult({
        score: 0.97,
        allTimeScore: 0.95,
        observedHours: 72, // 3 days of coverage
        truncated: true,
      }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("3.0d");
    expect(html).not.toContain(">7d<");
  });

  it("renders days-unit coverage when a young pool hasn't accumulated 7d yet", () => {
    // Coverage shorter than nominal window but no truncation — same
    // treatment: show what we actually have, not the nominal window.
    mockUseHealthScore.mockReturnValue(
      healthResult({
        score: 0.99,
        allTimeScore: 0.99,
        observedHours: 96, // 4 days old
        trackedSeconds: 96 * 3600,
      }),
    );
    const html = renderToStaticMarkup(<HealthScoreValue pool={BASE_POOL} />);
    expect(html).toContain("4.0d");
    expect(html).not.toContain(">7d<");
  });
});
