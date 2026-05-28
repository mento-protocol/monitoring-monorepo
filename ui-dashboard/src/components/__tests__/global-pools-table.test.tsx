import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";

let mockSearchParams = new URLSearchParams();
const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/pools",
}));

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  mockReplace.mockClear();
});

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
import {
  formatFee,
  hasFeeData,
} from "@/components/global-pools-table/formatting";

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

  it("does not make health badges dead tab stops", () => {
    const html = renderToStaticMarkup(
      <GlobalPoolsTable entries={[makeEntry()]} />,
    );
    expect(html).not.toMatch(/<button[^>]*title="[^"]*Oracle/);
    expect(html).toContain("sr-only");
    expect(html).toContain("Oracle stale — last update expired");
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

  it("sinks null TVL entries to the bottom regardless of direction", () => {
    // PR 1.7 (codex finding): untrusted-decimals pools surface as `null`
    // in tvlByKey. Mapping null to ±Infinity would put unknowns *above*
    // a real $0 pool in ascending order — claiming "lowest TVL." Match
    // the volume / total-volume / WoW pattern: nulls sink either way.
    const zero = makeEntry({ id: "zero" });
    const small = makeEntry({ id: "small" });
    const unknown = makeEntry({ id: "unknown" });
    const ctx: GlobalSortContext = {
      ...BASE_SORT_CTX,
      tvlByKey: new Map<string, number | null>([
        [globalPoolKey(zero), 0],
        [globalPoolKey(small), 5],
        [globalPoolKey(unknown), null],
      ]),
    };
    const desc = sortGlobalPools([zero, small, unknown], "tvl", "desc", ctx);
    expect(desc.map((e) => e.pool.id)).toEqual(["small", "zero", "unknown"]);
    const asc = sortGlobalPools([zero, small, unknown], "tvl", "asc", ctx);
    expect(asc.map((e) => e.pool.id)).toEqual(["zero", "small", "unknown"]);
  });
});

describe("sortGlobalPools — fee, health, and volume edge cases", () => {
  it("sinks missing fee rows in both directions while sorting known fees", () => {
    const low = makeEntry({ id: "low", lpFee: 10, protocolFee: 5 });
    const high = makeEntry({ id: "high", lpFee: 100, protocolFee: 25 });
    const sentinel = makeEntry({ id: "sentinel", lpFee: -1, protocolFee: 0 });
    const missing = makeEntry({ id: "missing" });

    const desc = sortGlobalPools(
      [sentinel, low, missing, high],
      "fee",
      "desc",
      BASE_SORT_CTX,
    );
    expect(desc.map((e) => e.pool.id).slice(0, 2)).toEqual(["high", "low"]);
    expect(
      desc
        .map((e) => e.pool.id)
        .slice(2)
        .sort(),
    ).toEqual(["missing", "sentinel"]);

    const asc = sortGlobalPools(
      [sentinel, low, missing, high],
      "fee",
      "asc",
      BASE_SORT_CTX,
    );
    expect(asc.map((e) => e.pool.id).slice(0, 2)).toEqual(["low", "high"]);
    expect(
      asc
        .map((e) => e.pool.id)
        .slice(2)
        .sort(),
    ).toEqual(["missing", "sentinel"]);
  });

  it("orders health by severity for both directions", () => {
    const freshTs = String(Math.floor(Date.now() / 1000) + 60);
    const ok = makeEntry({
      id: "ok",
      oracleTimestamp: freshTs,
      priceDifference: "0",
    });
    const warn = makeEntry({
      id: "warn",
      oracleTimestamp: freshTs,
      priceDifference: "600000000000000000",
      rebalanceThreshold: 500_000,
      rebalanceThresholdsKnown: true,
    });
    const critical = makeEntry({
      id: "critical",
      oracleTimestamp: freshTs,
      oracleOk: false,
    });

    expect(
      sortGlobalPools(
        [warn, critical, ok],
        "health",
        "desc",
        BASE_SORT_CTX,
      ).map((e) => e.pool.id),
    ).toEqual(["critical", "warn", "ok"]);
    expect(
      sortGlobalPools([warn, critical, ok], "health", "asc", BASE_SORT_CTX).map(
        (e) => e.pool.id,
      ),
    ).toEqual(["ok", "warn", "critical"]);
  });

  it("keeps same-id pools from different chains separate in metric maps", () => {
    const celo = makeEntry({ id: "shared" }, CELO_NETWORK);
    const monad = makeEntry({ id: "shared" }, MONAD_NETWORK);
    const ctx: GlobalSortContext = {
      ...BASE_SORT_CTX,
      totalVolumeByKey: new Map([
        [globalPoolKey(celo), 1],
        [globalPoolKey(monad), 100],
      ]),
    };

    expect(
      sortGlobalPools([celo, monad], "totalVolume", "desc", ctx).map(
        (e) => e.network.id,
      ),
    ).toEqual(["monad-mainnet", "celo-mainnet"]);
  });
});

describe("global pool fee formatting", () => {
  it("treats virtual, missing, and sentinel fees as unavailable", () => {
    expect(hasFeeData(makeEntry({ lpFee: 1, protocolFee: 2 }).pool)).toBe(true);
    expect(
      hasFeeData(makeEntry({ source: "virtual_pool", lpFee: 1 }).pool),
    ).toBe(false);
    expect(hasFeeData(makeEntry({ lpFee: -1, protocolFee: 0 }).pool)).toBe(
      false,
    );
    expect(hasFeeData(makeEntry().pool)).toBe(false);
  });

  it("formats known fees and renders an em dash for unavailable fees", () => {
    expect(formatFee(makeEntry({ lpFee: 12, protocolFee: 3 }).pool)).toBe(
      "0.15%",
    );
    expect(formatFee(makeEntry({ lpFee: -1, protocolFee: 0 }).pool)).toBe("—");
  });
});

// Strategy badge rendering

describe("GlobalPoolsTable — Strategy badge", () => {
  const POOL_ID = "pool-1";
  const WITH_REBALANCER = { id: POOL_ID, rebalancerAddress: "0xreb" };
  const NO_REBALANCER = { id: POOL_ID, rebalancerAddress: "" };

  it("renders a Reserve badge only when positively probed as Reserve", () => {
    const entry = makeEntry(WITH_REBALANCER);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable
        entries={[entry]}
        reservePoolKeys={new Set([globalPoolKey(entry)])}
      />,
    );
    expect(html).toContain(">Reserve<");
    expect(html).not.toContain(">CDP<");
    expect(html).not.toContain(">Open<");
  });

  it("renders NO badge when the pool has a rebalancer but probe is unavailable", () => {
    // Regression guard for the Cursor review finding: transport failures
    // used to collapse into a confident Reserve badge. The tri-state
    // contract says absence from all three sets = no badge, not Reserve.
    const entry = makeEntry(WITH_REBALANCER);
    const html = renderToStaticMarkup(<GlobalPoolsTable entries={[entry]} />);
    expect(html).not.toContain(">Reserve<");
    expect(html).not.toContain(">CDP<");
    expect(html).not.toContain(">Open<");
  });

  it("renders a CDP badge when the pool key is in cdpPoolKeys", () => {
    const entry = makeEntry(WITH_REBALANCER);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable
        entries={[entry]}
        cdpPoolKeys={new Set([globalPoolKey(entry)])}
      />,
    );
    expect(html).toContain(">CDP<");
    expect(html).not.toContain(">Reserve<");
  });

  it("renders an Open badge when the pool key is in olsPoolKeys", () => {
    const entry = makeEntry(WITH_REBALANCER);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable
        entries={[entry]}
        olsPoolKeys={new Set([globalPoolKey(entry)])}
      />,
    );
    expect(html).toContain(">Open<");
    expect(html).not.toContain(">Reserve<");
  });

  it("prefers Open over CDP and Reserve when a pool is in multiple sets", () => {
    const entry = makeEntry(WITH_REBALANCER);
    const key = globalPoolKey(entry);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable
        entries={[entry]}
        olsPoolKeys={new Set([key])}
        cdpPoolKeys={new Set([key])}
        reservePoolKeys={new Set([key])}
      />,
    );
    expect(html).toContain(">Open<");
    expect(html).not.toContain(">CDP<");
    expect(html).not.toContain(">Reserve<");
  });

  it("prefers CDP over Reserve when a pool is in both sets", () => {
    const entry = makeEntry(WITH_REBALANCER);
    const key = globalPoolKey(entry);
    const html = renderToStaticMarkup(
      <GlobalPoolsTable
        entries={[entry]}
        cdpPoolKeys={new Set([key])}
        reservePoolKeys={new Set([key])}
      />,
    );
    expect(html).toContain(">CDP<");
    expect(html).not.toContain(">Reserve<");
  });

  it("renders no strategy badge when a pool has no rebalancer and is in no strategy set", () => {
    const entry = makeEntry(NO_REBALANCER);
    const html = renderToStaticMarkup(<GlobalPoolsTable entries={[entry]} />);
    expect(html).not.toContain(">Reserve<");
    expect(html).not.toContain(">CDP<");
    expect(html).not.toContain(">Open<");
  });
});

/**
 * Extracts a `label → aria-sort` map from rendered HTML by splitting on
 * `</th>` and matching each segment independently. Robust against
 * cross-element regex matching.
 */
function ariaSortByLabel(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const seg of html.split("</th>")) {
    const sort = seg.match(/aria-sort="([^"]+)"/);
    const label = seg.match(/<button[^>]*>([^<]+)/);
    if (sort && label) result[label[1]!.trim()] = sort[1]!;
  }
  return result;
}

describe("GlobalPoolsTable — URL-driven sort wiring", () => {
  it("aria-sort on the active header matches the URL state", () => {
    mockSearchParams = new URLSearchParams("poolsSort=tvl&poolsDir=asc");
    const entry = makeEntry();
    const html = renderToStaticMarkup(<GlobalPoolsTable entries={[entry]} />);
    const sort = ariaSortByLabel(html);
    expect(sort.TVL).toBe("ascending");
    // sanity: a non-active column stays "none"
    expect(sort.Health).toBe("none");
  });

  it("falls back to defaultKey/defaultDir aria-sort when URL is empty", () => {
    mockSearchParams = new URLSearchParams();
    const entry = makeEntry();
    const html = renderToStaticMarkup(<GlobalPoolsTable entries={[entry]} />);
    const sort = ariaSortByLabel(html);
    expect(sort.TVL).toBe("descending");
  });
});
