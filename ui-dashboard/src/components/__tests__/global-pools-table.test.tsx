import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";

// Mock weekend detection so tests are deterministic.
vi.mock("@/lib/weekend", () => ({
  isWeekend: vi.fn(() => false),
  isWeekendOracleStale: vi.fn(() => false),
  FX_CLOSE_DAY: 5,
  FX_CLOSE_HOUR_UTC: 21,
  FX_REOPEN_DAY: 0,
  FX_REOPEN_HOUR_UTC: 23,
}));

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

import {
  GlobalPoolsTable,
  globalPoolKey,
  sortGlobalPools,
  type GlobalPoolEntry,
  type GlobalSortContext,
} from "@/components/global-pools-table";

const CELO_NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo Mainnet",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://example.com",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {
    "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b": "USDm",
    "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf": "KESm",
  },
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

const MONAD_NETWORK: Network = {
  ...CELO_NETWORK,
  id: "monad-mainnet",
  label: "Monad Mainnet",
  chainId: 143,
  hasVirtualPools: false,
};

const BASE_POOL: Pool = {
  id: "pool-1",
  chainId: 42220,
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

function makeEntry(
  pool: Partial<Pool> = {},
  network: Network = CELO_NETWORK,
): GlobalPoolEntry {
  return { pool: { ...BASE_POOL, ...pool }, network };
}

// ---------------------------------------------------------------------------
// globalPoolKey
// ---------------------------------------------------------------------------

describe("globalPoolKey", () => {
  it("generates network:poolId key", () => {
    const entry = makeEntry({ id: "abc" }, CELO_NETWORK);
    expect(globalPoolKey(entry)).toBe("celo-mainnet:abc");
  });

  it("produces distinct keys for same pool ID on different chains", () => {
    const celoEntry = makeEntry({ id: "pool-1" }, CELO_NETWORK);
    const monadEntry = makeEntry({ id: "pool-1" }, MONAD_NETWORK);
    expect(globalPoolKey(celoEntry)).not.toBe(globalPoolKey(monadEntry));
  });
});

// ---------------------------------------------------------------------------
// GlobalPoolsTable rendering
// ---------------------------------------------------------------------------

describe("GlobalPoolsTable — column structure", () => {
  it("renders Chain column header", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    expect(html).toContain("Chain");
  });

  it("renders pool name and chain label in the row", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    expect(html).toContain("Celo Mainnet");
    // Pool name: KESm/USDm (USDm is always last)
    expect(html).toContain("KESm");
    expect(html).toContain("USDm");
  });

  it("includes all expected column headers", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    expect(html).toContain("Pool");
    expect(html).toContain("Chain");
    expect(html).toContain("Health");
    expect(html).toContain("TVL");
    expect(html).toContain("24h Volume");
    expect(html).toContain("7d Volume");
    expect(html).toContain("Total Volume");
    expect(html).toContain("Swaps");
    expect(html).toContain("Rebalances");
    expect(html).toContain("Rebalancer");
  });

  it("hides Source column when no network has virtual pools", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry({}, CELO_NETWORK)]} />,
    );
    expect(html).not.toContain(">Source</th>");
  });

  it("shows Source column when at least one network has virtual pools", () => {
    const virtualNetwork: Network = {
      ...CELO_NETWORK,
      hasVirtualPools: true,
    };
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry({}, virtualNetwork)]} />,
    );
    expect(html).toContain(">Source</th>");
  });
});

describe("GlobalPoolsTable — pool detail link", () => {
  it("links to pool detail page with network param", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry({ id: "pool-abc" })]} />,
    );
    expect(html).toContain(
      `/pool/${encodeURIComponent("pool-abc")}?network=celo-mainnet`,
    );
  });
});

describe("GlobalPoolsTable — 24h volume states", () => {
  it("renders loading placeholder when volume24hLoading is true", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} volume24hLoading={true} />,
    );
    expect(html).toContain("…");
  });

  it("renders N/A when volume24hError is true", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} volume24hError={true} />,
    );
    expect(html).toContain("N/A");
  });

  it("renders formatted USD volume when present", () => {
    const entry = makeEntry({ id: "pool-1" });
    const volMap = new Map([[globalPoolKey(entry), 500]]);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[entry]} volume24hByKey={volMap} />,
    );
    expect(html).toContain("$500.00");
  });
});

describe("GlobalPoolsTable — 7d volume states", () => {
  it("renders loading placeholder when volume7dLoading is true", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} volume7dLoading={true} />,
    );
    expect(html).toContain("…");
  });

  it("renders N/A when volume7dError is true", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} volume7dError={true} />,
    );
    expect(html).toContain("N/A");
  });

  it("renders formatted USD 7d volume when present", () => {
    const entry = makeEntry({ id: "pool-1" });
    const volMap = new Map([[globalPoolKey(entry), 750]]);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[entry]} volume7dByKey={volMap} />,
    );
    expect(html).toContain("$750.00");
  });
});

describe("GlobalPoolsTable — multiple chains", () => {
  it("renders rows for pools from multiple chains", () => {
    const celoEntry = makeEntry({ id: "pool-1" }, CELO_NETWORK);
    const monadEntry = makeEntry({ id: "pool-1" }, MONAD_NETWORK);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[celoEntry, monadEntry]} />,
    );
    expect(html).toContain("Celo Mainnet");
    expect(html).toContain("Monad Mainnet");
  });
});

// ---------------------------------------------------------------------------
// sortGlobalPools unit tests
// ---------------------------------------------------------------------------

const BASE_SORT_CTX: GlobalSortContext = {
  tvlByKey: new Map(),
  totalVolumeByKey: new Map(),
};

describe("sortGlobalPools — TVL descending (default)", () => {
  it("orders entries by TVL descending", () => {
    const low = makeEntry({ id: "low" });
    const high = makeEntry({ id: "high" });
    const mid = makeEntry({ id: "mid" });
    const ctx: GlobalSortContext = {
      ...BASE_SORT_CTX,
      tvlByKey: new Map([
        [globalPoolKey(low), 1],
        [globalPoolKey(high), 100],
        [globalPoolKey(mid), 50],
      ]),
    };
    const result = sortGlobalPools([low, mid, high], "tvl", "desc", ctx);
    expect(result.map((e) => e.pool.id)).toEqual(["high", "mid", "low"]);
  });

  it("orders entries by TVL ascending when toggled", () => {
    const low = makeEntry({ id: "low" });
    const high = makeEntry({ id: "high" });
    const ctx: GlobalSortContext = {
      ...BASE_SORT_CTX,
      tvlByKey: new Map([
        [globalPoolKey(low), 1],
        [globalPoolKey(high), 100],
      ]),
    };
    const result = sortGlobalPools([high, low], "tvl", "asc", ctx);
    expect(result.map((e) => e.pool.id)).toEqual(["low", "high"]);
  });
});

describe("sortGlobalPools — chain sort", () => {
  it("orders by chain label alphabetically", () => {
    const celoEntry = makeEntry({ id: "pool-a" }, CELO_NETWORK);
    const monadEntry = makeEntry({ id: "pool-b" }, MONAD_NETWORK);
    // "Celo" < "Monad" alphabetically
    const asc = sortGlobalPools(
      [monadEntry, celoEntry],
      "chain",
      "asc",
      BASE_SORT_CTX,
    );
    expect(asc[0].network.label).toBe("Celo Mainnet");
    expect(asc[1].network.label).toBe("Monad Mainnet");

    const desc = sortGlobalPools(
      [celoEntry, monadEntry],
      "chain",
      "desc",
      BASE_SORT_CTX,
    );
    expect(desc[0].network.label).toBe("Monad Mainnet");
    expect(desc[1].network.label).toBe("Celo Mainnet");
  });
});
