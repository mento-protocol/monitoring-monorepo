import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Pool } from "@/lib/types";

// Mock weekend detection so component tests are deterministic (not day-of-week dependent).
// Tests that want to test weekend behaviour can override isWeekend per-test.
vi.mock("@/lib/weekend", () => ({
  isWeekend: vi.fn(() => false),
  isWeekendOracleStale: vi.fn(() => false),
  FX_CLOSE_DAY: 5,
  FX_CLOSE_HOUR_UTC: 21,
  FX_REOPEN_DAY: 0,
  FX_REOPEN_HOUR_UTC: 23,
}));

// Also mock weekend in health.ts resolution path
vi.mock("@/lib/health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/health")>();
  return actual;
});

const mockNetwork = {
  id: "celo-sepolia-local",
  label: "Celo Sepolia (local)",
  chainId: 11142220,
  contractsNamespace: "testnet-v2-rc5",
  hasuraUrl: "http://localhost:8080/v1/graphql",
  hasuraSecret: "testing",
  explorerBaseUrl: "https://celo-sepolia.blockscout.com",
  tokenSymbols: {
    "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b": "USDm",
    "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf": "KESm",
  },
  addressLabels: {},
  local: true,
  testnet: true,
  hasVirtualPools: true,
};

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: mockNetwork,
    networkId: "celo-sepolia-local",
    setNetworkId: vi.fn(),
  }),
}));

import { PoolsTable, sortPools } from "@/components/pools-table";
import type { SortContext } from "@/components/pools-table";

const BASE_POOL: Pool = {
  id: "pool-1",
  token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
  token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
  healthStatus: "OK",
  limitStatus: "OK",
};

function renderSinglePool(pool: Pool): string {
  return renderToStaticMarkup(<PoolsTable pools={[pool]} />);
}

function renderPoolTableMarkup(props: {
  volume24h?: Map<string, number | null>;
  volume24hLoading?: boolean;
  volume24hError?: boolean;
}): string {
  return renderToStaticMarkup(<PoolsTable pools={[BASE_POOL]} {...props} />);
}

describe("PoolsTable rebalancer tooltip", () => {
  it('shows "No rebalance events recorded yet" for FPMM with no lastRebalancedAt', () => {
    const html = renderSinglePool({ ...BASE_POOL, source: "fpmm_factory" });
    expect(html).toContain("No rebalance events recorded yet");
  });

  it('shows "No rebalance events recorded yet" for FPMM with lastRebalancedAt "0"', () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      source: "fpmm_factory",
      lastRebalancedAt: "0",
    });
    expect(html).toContain("No rebalance events recorded yet");
  });

  it('shows "VirtualPool — rebalancer not applicable" for VirtualPool', () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      source: "virtual_pool_factory",
    });
    expect(html).toContain("VirtualPool \u2014 rebalancer not applicable");
  });
});

describe("PoolsTable 24h volume states", () => {
  it("renders loading placeholder while 24h volume is loading", () => {
    const html = renderPoolTableMarkup({ volume24hLoading: true });
    expect(html).toContain("…");
  });

  it("renders N/A when 24h volume query failed", () => {
    const html = renderPoolTableMarkup({ volume24hError: true });
    expect(html).toContain("N/A");
  });

  it("renders N/A for non-convertible and formatted USD for convertible volumes", () => {
    const nullVolumeHtml = renderPoolTableMarkup({
      volume24h: new Map([["pool-1", null]]),
    });
    expect(nullVolumeHtml).toContain("N/A");

    const usdVolumeHtml = renderPoolTableMarkup({
      volume24h: new Map([["pool-1", 123]]),
    });
    expect(usdVolumeHtml).toContain("$123.00");
  });
});

describe("PoolsTable network-specific virtual pool UI", () => {
  it("shows the Source column on networks with virtual pools", () => {
    mockNetwork.hasVirtualPools = true;
    const html = renderPoolTableMarkup({});
    expect(html).toContain(">Source</th>");
    expect(html).toContain("FPMM");
  });

  it("hides the Source column on networks without virtual pools", () => {
    mockNetwork.hasVirtualPools = false;
    const html = renderPoolTableMarkup({});
    expect(html).not.toContain(">Source</th>");
    expect(html).not.toContain("Virtual");
    expect(html).not.toContain("FPMM");
    mockNetwork.hasVirtualPools = true;
  });
});

describe("PoolsTable column structure", () => {
  it("renders the new column headers and omits removed ones", () => {
    const html = renderPoolTableMarkup({});
    expect(html).toContain("24h Volume");
    expect(html).toContain("Total Volume");
    expect(html).toContain("Swaps");
    expect(html).toContain("Rebalances");
    // Removed columns
    expect(html).not.toContain(">Limit</th>");
    expect(html).not.toContain(">Created</th>");
  });
});

describe("PoolsTable combined Health + Limit badge", () => {
  it("elevates badge to CRITICAL when limitStatus is CRITICAL but healthStatus is OK", () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      healthStatus: "OK",
      limitStatus: "CRITICAL",
      oracleTimestamp: String(Math.floor(Date.now() / 1000)), // fresh oracle
      limitPressure0: "1.05",
      limitPressure1: "0.1",
    });
    // The Health badge cell should show CRITICAL
    expect(html).toContain("CRITICAL");
  });

  it("keeps badge at CRITICAL when healthStatus is CRITICAL and limitStatus is OK", () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      healthStatus: "CRITICAL",
      limitStatus: "OK",
    });
    expect(html).toContain("CRITICAL");
  });

  it("shows 'Needs rebalance' tooltip when health is CRITICAL due to deviation", () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      healthStatus: "CRITICAL",
      limitStatus: "OK",
      oracleTimestamp: String(Math.floor(Date.now() / 1000)), // fresh oracle → deviation-driven
      priceDifference: "5000",
      rebalanceThreshold: 5000,
    });
    expect(html).toContain("Needs rebalance: price deviation");
  });

  it("includes per-token pressure in tooltip when limit is CRITICAL", () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      healthStatus: "OK",
      limitStatus: "CRITICAL",
      oracleTimestamp: String(Math.floor(Date.now() / 1000)),
      limitPressure0: "1.05",
      limitPressure1: "0.12",
    });
    // Tooltip should mention token symbols and pressure percentages
    expect(html).toContain("105%");
    expect(html).toContain("12%");
  });
});

describe("PoolsTable weekend banner", () => {
  it("shows weekend banner when isWeekend returns true", async () => {
    const weekend = await import("@/lib/weekend");
    vi.mocked(weekend.isWeekend).mockReturnValueOnce(true);
    const html = renderSinglePool({ ...BASE_POOL });
    expect(html).toContain("FX markets are closed this weekend");
  });

  it("does not show weekend banner when isWeekend returns false", () => {
    // Default mock returns false
    const html = renderSinglePool({ ...BASE_POOL });
    expect(html).not.toContain("FX markets are closed this weekend");
  });
});

describe("PoolsTable Total Volume column", () => {
  it("shows formatted USD for a pool with USDm as token0", () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      token0Decimals: 18,
      notionalVolume0: "5000000000000000000", // 5 USDm
    });
    expect(html).toContain("$5.00");
  });

  it("shows — for a pool with no USDm leg", () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      notionalVolume0: "1000000000000000000",
      notionalVolume1: "2000000000000000000",
    });
    // Non-convertible pools must NOT show any USD-formatted total volume value
    expect(html).not.toContain("$1.00");
    expect(html).not.toContain("$2.00");
  });

  it("shows $0.00 for a USD-convertible pool with zero all-time volume", () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      token0Decimals: 18,
      // notionalVolume0 absent — poolTotalVolumeUSD returns 0, not null
    });
    expect(html).toContain("$0.00");
  });
});

describe("PoolsTable Swaps and Rebalances columns", () => {
  it("renders all-time swap and rebalance counts", () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      swapCount: 7,
      rebalanceCount: 3,
    });
    expect(html).toContain(">7<");
    expect(html).toContain(">3<");
  });
});

// ─── sortPools unit tests ────────────────────────────────────────────────────

const SORT_CONTEXT: SortContext = {
  network: mockNetwork as SortContext["network"],
  tvlByPoolId: new Map(),
  totalVolumeByPoolId: new Map(),
  volume24h: undefined,
};

function makePool(id: string, overrides: Partial<Pool> = {}): Pool {
  return {
    ...BASE_POOL,
    id,
    token0: BASE_POOL.token0,
    token1: BASE_POOL.token1,
    ...overrides,
  };
}

describe("sortPools — default totalVolume desc", () => {
  it("orders pools by total volume descending by default", () => {
    const low = makePool("low", { notionalVolume0: "1000000000000000000" }); // 1 USDm
    const high = makePool("high", { notionalVolume0: "5000000000000000000" }); // 5 USDm
    const mid = makePool("mid", { notionalVolume0: "3000000000000000000" }); // 3 USDm
    const ctx: SortContext = {
      ...SORT_CONTEXT,
      totalVolumeByPoolId: new Map([
        ["low", 1],
        ["high", 5],
        ["mid", 3],
      ]),
    };
    const result = sortPools([low, mid, high], "totalVolume", "desc", ctx);
    expect(result.map((p) => p.id)).toEqual(["high", "mid", "low"]);
  });

  it("orders pools by total volume ascending when toggled", () => {
    const ctx: SortContext = {
      ...SORT_CONTEXT,
      totalVolumeByPoolId: new Map([
        ["low", 1],
        ["high", 5],
        ["mid", 3],
      ]),
    };
    const pools = [makePool("low"), makePool("mid"), makePool("high")];
    const result = sortPools(pools, "totalVolume", "asc", ctx);
    expect(result.map((p) => p.id)).toEqual(["low", "mid", "high"]);
  });
});

describe("sortPools — health severity ordering", () => {
  const now = String(Math.floor(Date.now() / 1000));
  // threshold = 5000; devRatio controls computed health status:
  //   CRITICAL: priceDifference / threshold >= 1.0  (e.g. 5001)
  //   WARN:     devRatio 0.8–1.0                    (e.g. 4500 → 0.9)
  //   OK:       devRatio < 0.8                      (e.g. 100  → 0.02)
  const THRESHOLD = 5000;

  const freshCritical: Partial<Pool> = {
    oracleTimestamp: now,
    priceDifference: "5001",
    rebalanceThreshold: THRESHOLD,
    limitStatus: "OK",
  };
  const freshWarn: Partial<Pool> = {
    oracleTimestamp: now,
    priceDifference: "4500",
    rebalanceThreshold: THRESHOLD,
    limitStatus: "OK",
  };
  const freshOk: Partial<Pool> = {
    oracleTimestamp: now,
    priceDifference: "100",
    rebalanceThreshold: THRESHOLD,
    limitStatus: "OK",
  };

  it("orders CRITICAL → WARN → OK → N/A descending", () => {
    const ok = makePool("ok", freshOk);
    const critical = makePool("critical", freshCritical);
    const warn = makePool("warn", freshWarn);
    const na = makePool("na", {
      source: "virtual_pool_factory",
      limitStatus: "N/A",
    });
    const result = sortPools(
      [ok, warn, critical, na],
      "health",
      "desc",
      SORT_CONTEXT,
    );
    expect(result.map((p) => p.id)).toEqual(["critical", "warn", "ok", "na"]);
  });

  it("orders N/A → OK → WARN → CRITICAL ascending", () => {
    const ok = makePool("ok", freshOk);
    const critical = makePool("critical", freshCritical);
    const warn = makePool("warn", freshWarn);
    const na = makePool("na", {
      source: "virtual_pool_factory",
      limitStatus: "N/A",
    });
    const result = sortPools(
      [ok, warn, critical, na],
      "health",
      "asc",
      SORT_CONTEXT,
    );
    expect(result.map((p) => p.id)).toEqual(["na", "ok", "warn", "critical"]);
  });

  it("uses worstStatus so limitStatus can elevate health rank", () => {
    // Both pools have OK oracle health; only limit-critical has limitStatus: CRITICAL
    const healthOkLimitCritical = makePool("limit-critical", {
      ...freshOk,
      limitStatus: "CRITICAL",
    });
    const healthOkLimitOk = makePool("both-ok", freshOk);
    const result = sortPools(
      [healthOkLimitOk, healthOkLimitCritical],
      "health",
      "desc",
      SORT_CONTEXT,
    );
    expect(result.map((p) => p.id)).toEqual(["limit-critical", "both-ok"]);
  });
});

describe("sortPools — swaps and rebalances", () => {
  it("orders by swap count descending", () => {
    const pools = [
      makePool("a", { swapCount: 10 }),
      makePool("b", { swapCount: 50 }),
      makePool("c", { swapCount: 5 }),
    ];
    const result = sortPools(pools, "swaps", "desc", SORT_CONTEXT);
    expect(result.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("orders by rebalance count ascending", () => {
    const pools = [
      makePool("a", { rebalanceCount: 10 }),
      makePool("b", { rebalanceCount: 2 }),
      makePool("c", { rebalanceCount: 7 }),
    ];
    const result = sortPools(pools, "rebalances", "asc", SORT_CONTEXT);
    expect(result.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });
});
