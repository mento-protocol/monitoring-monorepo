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
  label: "Celo",
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
  label: "Monad",
  chainId: 143,
  hasVirtualPools: false,
};

// Non-canonical variant sharing chainId 42220 with celo-mainnet.
const CELO_MAINNET_LOCAL_NETWORK: Network = {
  ...CELO_NETWORK,
  id: "celo-mainnet-local",
  label: "Celo (local)",
  local: true,
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
  return { pool: { ...BASE_POOL, ...pool }, network, rates: new Map() };
}

// globalPoolKey

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

// GlobalPoolsTable rendering

describe("GlobalPoolsTable — column structure", () => {
  it("renders a branded chain icon before the pool name", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    expect(html).toContain('aria-label="Celo"');
    expect(html).toContain('class="web3icons"');
  });

  it("renders pool name in the row", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    // Pool name: KESm/USDm (USDm is always last)
    expect(html).toContain("KESm");
    expect(html).toContain("USDm");
  });

  it("includes all expected column headers", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    expect(html).toContain(">Pool<");
    expect(html).toContain(">Health<");
    expect(html).toContain(">TVL<");
    expect(html).toContain("TVL Δ WoW");
    expect(html).toContain("24h Vol.");
    expect(html).toContain("7d Vol.");
    expect(html).toContain("Total Vol.");
    expect(html).toContain(">Fee<");
    expect(html).toContain(">Limits<");
    expect(html).toContain(">Strategy<");
  });

  it("does not render a Chain column header", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    expect(html).not.toContain(">Chain</button>");
  });

  it("hides Type column when no network has virtual pools", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry({}, CELO_NETWORK)]} />,
    );
    expect(html).not.toContain(">Type</th>");
  });

  it("shows Type column when at least one network has virtual pools", () => {
    const virtualNetwork: Network = {
      ...CELO_NETWORK,
      hasVirtualPools: true,
    };
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry({}, virtualNetwork)]} />,
    );
    expect(html).toContain(">Type</th>");
  });

  it("renders FPMM badge for a Monad entry when Type column is visible", () => {
    const virtualCelo: Network = {
      ...CELO_NETWORK,
      hasVirtualPools: true,
    };
    const celoEntry = makeEntry({}, virtualCelo);
    const monadEntry = makeEntry(
      { id: "monad-pool-1", source: "fpmm_factory" },
      MONAD_NETWORK,
    );
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[celoEntry, monadEntry]} />,
    );
    expect(html).toContain(">Type</th>");
    expect(html).toContain("FPMM");
    expect(html).toContain('aria-label="Monad"');
  });
});

describe("GlobalPoolsTable — pool detail link", () => {
  const NAMESPACED_ID = "42220-0x0000000000000000000000000000000000000001";

  it("renders /pool/<id> with no query string (chain recoverable from namespaced id)", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry({ id: NAMESPACED_ID })]} />,
    );
    expect(html).toContain(`href="/pool/${encodeURIComponent(NAMESPACED_ID)}"`);
    expect(html).not.toContain("?network=");
  });

  it("renders the same bare /pool/<id> URL regardless of the originating network", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable
        entries={[makeEntry({ id: NAMESPACED_ID }, CELO_MAINNET_LOCAL_NETWORK)]}
      />,
    );
    expect(html).toContain(`href="/pool/${encodeURIComponent(NAMESPACED_ID)}"`);
    expect(html).not.toContain("?network=");
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

describe("GlobalPoolsTable — TVL WoW column", () => {
  it("renders em-dash in the WoW cell when tvlChangeWoWByKey is missing", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    expect(html).toMatch(/font-mono text-slate-600[^>]*>—/);
  });

  it("renders em-dash when the pool has no WoW entry (no comparable snapshot)", () => {
    const entry = makeEntry({ id: "pool-1" });
    // Empty map — no entry for this pool's key.
    const wowMap = new Map<string, number | null>();
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[entry]} tvlChangeWoWByKey={wowMap} />,
    );
    expect(html).toMatch(/font-mono text-slate-600[^>]*>—/);
  });

  it("renders N/A when the WoW value is explicitly null (snapshot query failed)", () => {
    const entry = makeEntry({ id: "pool-1" });
    const wowMap = new Map<string, number | null>([
      [globalPoolKey(entry), null],
    ]);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[entry]} tvlChangeWoWByKey={wowMap} />,
    );
    expect(html).toMatch(/font-mono text-slate-400[^>]*>N\/A/);
  });

  it("renders positive WoW with + prefix and emerald color in the same cell", () => {
    const entry = makeEntry({ id: "pool-1" });
    const wowMap = new Map<string, number | null>([
      [globalPoolKey(entry), 2.345],
    ]);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[entry]} tvlChangeWoWByKey={wowMap} />,
    );
    expect(html).toMatch(/text-emerald-400[^<]*>\+2\.35%/);
  });

  it("renders negative WoW with - prefix and red color in the same cell", () => {
    const entry = makeEntry({ id: "pool-1" });
    const wowMap = new Map<string, number | null>([
      [globalPoolKey(entry), -1.1],
    ]);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[entry]} tvlChangeWoWByKey={wowMap} />,
    );
    expect(html).toMatch(/text-red-400[^<]*>-1\.10%/);
  });
});

describe("sortGlobalPools — tvlChangeWoW null + missing both sink", () => {
  it("sinks null (error) and missing-key (no data) entries to bottom when sorted desc", () => {
    const a = makeEntry({ id: "a" });
    const b = makeEntry({ id: "b" }); // null = error
    const c = makeEntry({ id: "c" });
    const d = makeEntry({ id: "d" }); // absent = no data
    const wowMap = new Map<string, number | null>([
      [globalPoolKey(a), 5],
      [globalPoolKey(b), null],
      [globalPoolKey(c), -3],
    ]);
    const ctx: GlobalSortContext = {
      ...BASE_SORT_CTX,
      tvlChangeWoWByKey: wowMap,
    };
    const desc = sortGlobalPools([b, d, a, c], "tvlChangeWoW", "desc", ctx);
    expect(desc.map((e) => e.pool.id).slice(0, 2)).toEqual(["a", "c"]);
    expect(
      desc
        .map((e) => e.pool.id)
        .slice(2)
        .sort(),
    ).toEqual(["b", "d"]);
  });

  it("sinks null and missing-key entries to bottom when sorted asc", () => {
    const a = makeEntry({ id: "a" });
    const b = makeEntry({ id: "b" });
    const c = makeEntry({ id: "c" });
    const d = makeEntry({ id: "d" });
    const wowMap = new Map<string, number | null>([
      [globalPoolKey(a), 5],
      [globalPoolKey(b), null],
      [globalPoolKey(c), -3],
    ]);
    const ctx: GlobalSortContext = {
      ...BASE_SORT_CTX,
      tvlChangeWoWByKey: wowMap,
    };
    const asc = sortGlobalPools([b, d, a, c], "tvlChangeWoW", "asc", ctx);
    expect(asc.map((e) => e.pool.id).slice(0, 2)).toEqual(["c", "a"]);
    expect(
      asc
        .map((e) => e.pool.id)
        .slice(2)
        .sort(),
    ).toEqual(["b", "d"]);
  });
});

describe("GlobalPoolsTable — multiple chains", () => {
  it("renders one row per pool entry across chains", () => {
    const celoEntry = makeEntry({ id: "pool-1" }, CELO_NETWORK);
    const monadEntry = makeEntry({ id: "pool-1" }, MONAD_NETWORK);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[celoEntry, monadEntry]} />,
    );
    expect(html).toContain('aria-label="Celo"');
    expect(html).toContain('aria-label="Monad"');
    // header row + 2 data rows = 3 <tr>
    const trCount = (html.match(/<tr\b/g) ?? []).length;
    expect(trCount).toBe(3);
  });
});

// sortGlobalPools unit tests

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
