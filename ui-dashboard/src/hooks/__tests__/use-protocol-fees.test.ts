/**
 * Orchestration tests for `useProtocolFees`.
 *
 * Strategy: mock `swr` to capture the fetcher passed as the second argument,
 * then call it directly. This exercises `fetchAllProtocolFees` (which is not
 * exported) without DOM rendering or SWR revalidation noise. The `graphql-
 * request` mock routes each `client.request()` call based on the query
 * document string — the same pattern used in `use-all-networks-data.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NetworkData } from "@/lib/fetch-all-networks";

// ---------------------------------------------------------------------------
// SWR mock — capture the fetcher so we can call it directly in each test.
// ---------------------------------------------------------------------------

let capturedFetcher: (() => Promise<NetworkData[]>) | null = null;

vi.mock("swr", () => ({
  default: (
    _key: string,
    fetcher: () => Promise<NetworkData[]>,
  ): { data: undefined; isLoading: boolean } => {
    capturedFetcher = fetcher;
    return { data: undefined, isLoading: false };
  },
}));

// ---------------------------------------------------------------------------
// graphql-request mock — routes requests by document string.
// ---------------------------------------------------------------------------

vi.mock("graphql-request", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

import { GraphQLClient } from "graphql-request";

// ---------------------------------------------------------------------------
// @/lib/networks mock — `vi.hoisted` shares mutable state with the hoisted
// `vi.mock` factory so individual tests can swap the network registry to
// exercise paths like the missing-Hasura-URL guard. The mock factory exposes
// `NETWORK_IDS` / `NETWORKS` / `isConfiguredNetworkId` as live getters so each
// `runFetcher()` call sees the current `mocks.*` state.
// ---------------------------------------------------------------------------

const DEFAULT_CELO = {
  id: "celo-mainnet" as const,
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://celo.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  hasVirtualPools: false,
  testnet: false,
};

const DEFAULT_MONAD = {
  id: "monad-mainnet" as const,
  label: "Monad",
  chainId: 143,
  contractsNamespace: null,
  hasuraUrl: "https://monad.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://monadscan.com",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  hasVirtualPools: false,
  testnet: false,
};

const mocks = vi.hoisted(() => ({
  networkIds: ["celo-mainnet", "monad-mainnet"] as string[],
  networks: {} as Record<string, unknown>,
}));

vi.mock("@/lib/networks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/networks")>();
  return {
    ...actual,
    get NETWORK_IDS() {
      return mocks.networkIds;
    },
    get NETWORKS() {
      return mocks.networks;
    },
    isConfiguredNetworkId: (id: string) => mocks.networkIds.includes(id),
  };
});

// Boot the hook module AFTER all vi.mock() calls are in place. Importing
// triggers the module-level type resolution; `capturedFetcher` gets populated
// each time `useProtocolFees()` is called.
import { useProtocolFees } from "../use-protocol-fees";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the GQL document string from either the object or positional form. */
function extractQuery(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "document" in arg) {
    const doc = (arg as { document: unknown }).document;
    if (typeof doc === "string") return doc;
  }
  return "";
}

/**
 * Set up a per-query response implementation for all `GraphQLClient.request`
 * calls. Each invocation routes based on the query document string. Use this
 * for tests where every chain returns the same fixture; for per-chain routing
 * see Case 7's inline `mockImplementation` which inspects the constructor's
 * URL history.
 */
function mockRequest(impl: (query: string) => unknown | Promise<unknown>) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation((...args: unknown[]) => {
    const query = extractQuery(args[0]);
    const result = impl(query);
    return result instanceof Promise ? result : Promise.resolve(result);
  });
}

/** Invoke the hook (which populates `capturedFetcher` via the SWR mock). */
function bootHook() {
  capturedFetcher = null;
  useProtocolFees();
}

/** Run the hook and return the fetched data. */
async function runFetcher(): Promise<NetworkData[]> {
  bootHook();
  if (!capturedFetcher) throw new Error("SWR fetcher was never captured");
  return capturedFetcher();
}

// ---------------------------------------------------------------------------
// Fixtures
//
// USDC is USD-pegged so `tokenToUSD("USDC", amount, emptyMap)` still returns
// a value even when the oracle map is empty — useful for validating that
// `fees` is non-null on success without needing a fully-wired rate fixture.
// ---------------------------------------------------------------------------

const USDC_TRANSFER = {
  chainId: 42220,
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  amount: "1000000", // 1 USDC
  blockTimestamp: String(Math.floor(Date.now() / 1000) - 3600), // 1h ago
  from: "0xpool",
};

// Pool label fixture — minimal fields required by PoolLabel.
const POOL_LABEL = {
  id: "42220-0xpool",
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "FPMM",
};

// Oracle pool: USDm leg + EURm leg at ~1.14 USD/EUR (Fixidity 1e24).
// buildOracleRateMap only extracts from pools where one token is in USDM_SYMBOLS
// ("USDm"). Tokens are addresses resolved via network.tokenSymbols — since our
// mock network has empty tokenSymbols, token0/token1 pass through truncateAddress
// unchanged. We set them as the actual symbol strings so the fallback lookup
// returns them as-is (the address lookup chain: tokenSymbols[lower] → addressLabels[lower]
// → truncateAddress). Since our mock tokenSymbols/addressLabels are empty and
// the values don't look like hex addresses, tokenSymbol() returns them verbatim.
const ORACLE_POOL = {
  token0: "USDm",
  token1: "EURm",
  oraclePrice: "1140000000000000000000000", // 1.14 in Fixidity
  oracleOk: true,
};

// Pre-rolled fee snapshot — one row per chain × day. The hybrid pricing field
// `feesUsdWei` carries the USD-pegged subtotal; FX tokens (none here) would
// fan out across the parallel `tokens[]` arrays.
const FEE_SNAPSHOT = {
  id: "42220-0xpool-1700000000",
  chainId: 42220,
  poolAddress: "0xpool",
  timestamp: "1700000000",
  tokens: ["0xtok"],
  tokenSymbols: ["USDm"],
  tokenDecimals: [18],
  amounts: ["1000000000000000000"],
  feesUsdWei: "1000000000000000000",
};

/** Happy-path mock: all four queries return non-empty data. */
function setupSuccessfulMock() {
  mockRequest((query) => {
    if (query.includes("OracleRates")) return { Pool: [ORACLE_POOL] };
    if (query.includes("ProtocolFeeTransfer"))
      return { ProtocolFeeTransfer: [USDC_TRANSFER] };
    if (query.includes("PoolLabelsAll")) return { Pool: [POOL_LABEL] };
    if (query.includes("PoolDailyFeeSnapshotsPage"))
      return { PoolDailyFeeSnapshot: [FEE_SNAPSHOT] };
    return {};
  });
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  // `resetAllMocks` (not `clearAllMocks`) is required because some tests set
  // a mockImplementation on `GraphQLClient` itself (the constructor) — clear
  // only wipes call history, leaving the implementation in place to leak
  // into the next test. Reset wipes both.
  vi.resetAllMocks();
  capturedFetcher = null;
  mocks.networkIds = ["celo-mainnet", "monad-mainnet"];
  mocks.networks = {
    "celo-mainnet": DEFAULT_CELO,
    "monad-mainnet": DEFAULT_MONAD,
  };
});

// ---------------------------------------------------------------------------
// Case 1: All three queries succeed
// ---------------------------------------------------------------------------

describe("useProtocolFees — all queries succeed", () => {
  it("populates fees, feeTransfers, feeSnapshots, poolLabels and leaves feesError null", async () => {
    setupSuccessfulMock();

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    expect(celo.feesError).toBeNull();
    expect(celo.error).toBeNull();
    // aggregateProtocolFees always returns a summary (never null) on success.
    expect(celo.fees).not.toBeNull();
    expect(celo.feeTransfers).toHaveLength(1);
    expect(celo.feeSnapshots).toHaveLength(1);
    expect(celo.feeSnapshots[0]).toMatchObject({ tokenSymbols: ["USDm"] });
    expect(celo.poolLabels.size).toBeGreaterThan(0);
  });

  it("returns one NetworkData per configured network", async () => {
    setupSuccessfulMock();

    const results = await runFetcher();

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.network.id);
    expect(ids).toContain("celo-mainnet");
    expect(ids).toContain("monad-mainnet");
  });

  it("rates map is populated from oracle pools", async () => {
    setupSuccessfulMock();

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    // EURm should appear in the rates map from the ORACLE_POOL fixture.
    expect(celo.rates.has("EURm")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 2: Fees query rejects, rates + labels succeed
// ---------------------------------------------------------------------------

describe("useProtocolFees — fees query rejects", () => {
  it("sets feesError to the rejection, feeTransfers to [], fees to null; poolLabels still populated", async () => {
    const feesErr = new Error("fees transfer timeout");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const query = extractQuery(args[0]);
      if (query.includes("ProtocolFeeTransfer")) return Promise.reject(feesErr);
      if (query.includes("OracleRates"))
        return Promise.resolve({ Pool: [ORACLE_POOL] });
      if (query.includes("PoolLabelsAll"))
        return Promise.resolve({ Pool: [POOL_LABEL] });
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    expect(celo.feesError).toBe(feesErr);
    expect(celo.feeTransfers).toHaveLength(0);
    expect(celo.fees).toBeNull();
    // Labels are independent — non-fatal; leaderboard still gets labels.
    expect(celo.poolLabels.size).toBeGreaterThan(0);
    expect(celo.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 3: Rates query rejects, fees + labels succeed — load-bearing invariant
// ---------------------------------------------------------------------------

describe("useProtocolFees — rates query rejects (load-bearing invariant)", () => {
  it("promotes feesError to the rates rejection; fees null; feeTransfers preserved; poolLabels populated", async () => {
    const ratesErr = new Error("oracle rates unavailable");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const query = extractQuery(args[0]);
      if (query.includes("OracleRates")) return Promise.reject(ratesErr);
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [USDC_TRANSFER] });
      if (query.includes("PoolLabelsAll"))
        return Promise.resolve({ Pool: [POOL_LABEL] });
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    // The rates failure MUST be promoted to feesError — without rates,
    // aggregateProtocolFees silently zeros non-USD-pegged fees, producing
    // a confidently-wrong lower bound.
    expect(celo.feesError).toBe(ratesErr);
    expect(celo.fees).toBeNull();
    // Raw transfers are preserved so callers can still time-bucket them.
    expect(celo.feeTransfers).toHaveLength(1);
    expect(celo.feeTransfers[0]).toMatchObject({ tokenSymbol: "USDC" });
    expect(celo.poolLabels.size).toBeGreaterThan(0);
    expect(celo.error).toBeNull();
  });

  it("fees failure takes precedence over rates failure in feesError", async () => {
    // When both fees and rates reject, feesError should be the fees error
    // (first branch in the ternary: feesResult.status === "rejected" wins).
    const feesErr = new Error("fees rejected first");
    const ratesErr = new Error("rates also rejected");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const query = extractQuery(args[0]);
      if (query.includes("OracleRates")) return Promise.reject(ratesErr);
      if (query.includes("ProtocolFeeTransfer")) return Promise.reject(feesErr);
      if (query.includes("PoolLabelsAll")) return Promise.resolve({ Pool: [] });
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    // Fees rejection wins by precedence in the hook's ternary.
    expect(celo.feesError).toBe(feesErr);
    expect(celo.feesError).not.toBe(ratesErr);
  });
});

// ---------------------------------------------------------------------------
// Case 4: Labels query rejects, rates + fees succeed — non-fatal
// ---------------------------------------------------------------------------

describe("useProtocolFees — labels query rejects (non-fatal)", () => {
  it("feesError stays null; fees populated; poolLabels empty Map; feeTransfers preserved", async () => {
    const labelsErr = new Error("pool labels timeout");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const query = extractQuery(args[0]);
      if (query.includes("PoolLabelsAll")) return Promise.reject(labelsErr);
      if (query.includes("OracleRates"))
        return Promise.resolve({ Pool: [ORACLE_POOL] });
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [USDC_TRANSFER] });
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    // Labels failure is non-fatal — leaderboard falls back to truncated-address labels.
    expect(celo.feesError).toBeNull();
    expect(celo.fees).not.toBeNull();
    expect(celo.feeTransfers).toHaveLength(1);
    // Labels map stays empty (no error promoted).
    expect(celo.poolLabels.size).toBe(0);
    expect(celo.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 5: All three queries reject
// ---------------------------------------------------------------------------

describe("useProtocolFees — all three queries reject", () => {
  it("feesError is the fees rejection (precedence), fees null, feeTransfers empty, poolLabels empty", async () => {
    const feesErr = new Error("fees gone");
    const ratesErr = new Error("rates gone");
    const labelsErr = new Error("labels gone");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const query = extractQuery(args[0]);
      if (query.includes("OracleRates")) return Promise.reject(ratesErr);
      if (query.includes("ProtocolFeeTransfer")) return Promise.reject(feesErr);
      if (query.includes("PoolLabelsAll")) return Promise.reject(labelsErr);
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    // Fees rejection takes precedence in the hook's ternary.
    expect(celo.feesError).toBe(feesErr);
    expect(celo.fees).toBeNull();
    expect(celo.feeTransfers).toHaveLength(0);
    expect(celo.poolLabels.size).toBe(0);
    expect(celo.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 6: Hasura URL missing — driven through the actual hook fetch path.
// ---------------------------------------------------------------------------

describe("useProtocolFees — hasura URL guard", () => {
  it("when network has empty hasuraUrl, no GraphQL queries fire and result.error carries the guard message", async () => {
    // Override the hoisted networks fixture for THIS test only — the
    // beforeEach resets it. Single chain to make the assertions sharp.
    mocks.networkIds = ["celo-mainnet"];
    mocks.networks = {
      "celo-mainnet": { ...DEFAULT_CELO, hasuraUrl: "", label: "Celo No URL" },
    };

    const results = await runFetcher();

    expect(results).toHaveLength(1);
    const celo = results[0];
    expect(celo.error).not.toBeNull();
    expect(celo.error?.message).toContain("Hasura URL not configured");
    expect(celo.error?.message).toContain("Celo No URL");
    expect(celo.fees).toBeNull();
    expect(celo.feeTransfers).toHaveLength(0);
    expect(celo.poolLabels.size).toBe(0);
    expect(celo.feesError).toBeNull(); // error is on `error`, not `feesError`

    // Guard short-circuits BEFORE any client construction. No GraphQL
    // requests should have fired and no client should have been built.
    expect(GraphQLClient).not.toHaveBeenCalled();
    expect(GraphQLClient.prototype.request).not.toHaveBeenCalled();
  });

  it("the configured-URL network in a mixed fixture doesn't get blanked by another network's missing URL", async () => {
    // One chain has a URL, the other doesn't. The URL-having chain must
    // still hit the network and return populated data.
    mocks.networkIds = ["celo-mainnet", "monad-mainnet"];
    mocks.networks = {
      "celo-mainnet": DEFAULT_CELO,
      "monad-mainnet": { ...DEFAULT_MONAD, hasuraUrl: "" },
    };
    setupSuccessfulMock();

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    const monad = results.find((r) => r.network.id === "monad-mainnet")!;

    // Celo: full success.
    expect(celo.error).toBeNull();
    expect(celo.fees).not.toBeNull();
    expect(celo.feeTransfers).toHaveLength(1);

    // Monad: guard fired.
    expect(monad.error?.message).toContain("Hasura URL not configured");
    expect(monad.fees).toBeNull();
    expect(monad.feeTransfers).toHaveLength(0);

    // GraphQLClient should have been constructed exactly once (for Celo).
    expect(GraphQLClient).toHaveBeenCalledTimes(1);
    expect((GraphQLClient as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      DEFAULT_CELO.hasuraUrl,
    );
  });
});

// ---------------------------------------------------------------------------
// Case 6.5: Snapshot branch failures — promoted into feesError
// ---------------------------------------------------------------------------

describe("useProtocolFees — snapshot branch", () => {
  it("snapshot first-page failure promotes into feesError; fees still aggregated from raw transfers", async () => {
    const snapshotErr = new Error("snapshot 502");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const query = extractQuery(args[0]);
      if (query.includes("PoolDailyFeeSnapshotsPage"))
        return Promise.reject(snapshotErr);
      if (query.includes("OracleRates"))
        return Promise.resolve({ Pool: [ORACLE_POOL] });
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [USDC_TRANSFER] });
      if (query.includes("PoolLabelsAll"))
        return Promise.resolve({ Pool: [POOL_LABEL] });
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    // Snapshot rejection is the only thing left to fall through to in the
    // feesError ternary — fees + rates both succeeded.
    expect(celo.feesError).toBe(snapshotErr);
    // The chart's chain-level summary still wires up — it reads raw transfers,
    // not snapshots.
    expect(celo.fees).not.toBeNull();
    expect(celo.feeTransfers).toHaveLength(1);
    // Snapshot rows are empty after a first-page failure.
    expect(celo.feeSnapshots).toHaveLength(0);
  });

  it("fees rejection takes precedence over snapshot rejection in feesError", async () => {
    const feesErr = new Error("fees rejected first");
    const snapshotErr = new Error("snapshot also down");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const query = extractQuery(args[0]);
      if (query.includes("PoolDailyFeeSnapshotsPage"))
        return Promise.reject(snapshotErr);
      if (query.includes("ProtocolFeeTransfer")) return Promise.reject(feesErr);
      if (query.includes("OracleRates"))
        return Promise.resolve({ Pool: [ORACLE_POOL] });
      if (query.includes("PoolLabelsAll")) return Promise.resolve({ Pool: [] });
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    // Fees rejection wins by precedence in the hook's ternary.
    expect(celo.feesError).toBe(feesErr);
    expect(celo.feesError).not.toBe(snapshotErr);
  });
});

// ---------------------------------------------------------------------------
// Case 7: Two chains, one fails entirely — per-chain isolation
// ---------------------------------------------------------------------------

describe("useProtocolFees — per-chain isolation", () => {
  it("one chain with all queries failing does not blank the other chain", async () => {
    // All three of Monad's queries reject. fetchFeesForNetwork still returns
    // (via allSettled), carrying feesError. Celo is unaffected. We route by
    // the URL used to construct each GraphQLClient — works because each
    // fetchFeesForNetwork constructs its client and fires all three
    // request() calls synchronously before awaiting, so by the time
    // request() runs, the most-recently-constructed URL identifies the
    // current network.
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const constructedUrls = (
        GraphQLClient as ReturnType<typeof vi.fn>
      ).mock.calls.map((c: unknown[]) => c[0] as string);
      const lastUrl = constructedUrls[constructedUrls.length - 1] ?? "";
      const query = extractQuery(args[0]);

      if (lastUrl.includes("monad")) {
        return Promise.reject(new Error("monad network down"));
      }

      // Celo succeeds.
      if (query.includes("OracleRates"))
        return Promise.resolve({ Pool: [ORACLE_POOL] });
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [USDC_TRANSFER] });
      if (query.includes("PoolLabelsAll"))
        return Promise.resolve({ Pool: [POOL_LABEL] });
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    const monad = results.find((r) => r.network.id === "monad-mainnet")!;

    // Celo should be fully healthy.
    expect(celo.error).toBeNull();
    expect(celo.feesError).toBeNull();
    expect(celo.fees).not.toBeNull();
    expect(celo.feeTransfers).toHaveLength(1);

    // Monad: all three queries failed — feesError is set (fees rejection wins
    // precedence in the hook's ternary). The top-level `error` is null because
    // fetchFeesForNetwork still returned normally via Promise.allSettled.
    expect(monad.feesError).not.toBeNull();
    expect(monad.fees).toBeNull();
    expect(monad.feeTransfers).toHaveLength(0);
    expect(monad.network.id).toBe("monad-mainnet");
  });

  it("when fetchFeesForNetwork throws synchronously, the outer allSettled maps the rejection to result.error for THAT chain only", async () => {
    // Drive the outer rejection mapping in `fetchAllProtocolFees`: make the
    // GraphQLClient constructor throw for Monad's URL only. That throw
    // propagates out of fetchFeesForNetwork → outer Promise.allSettled
    // catches it → maps to blankNetworkData(NETWORKS[id], windows, { error }).
    const ctorErr = new Error("client construction failed for monad");
    // `function` (not arrow) so vi.fn can invoke it as a constructor when
    // `new GraphQLClient(...)` runs. Arrow functions are not constructible
    // and would surface as "is not a constructor" before our throw fires.
    (GraphQLClient as ReturnType<typeof vi.fn>).mockImplementation(function (
      this: object,
      url: string,
    ) {
      if (url.includes("monad")) throw ctorErr;
      // Celo: leave `this` as-is. `new` returns the constructed object
      // (an instance of GraphQLClient with the prototype's request mock).
    } as (this: object, ...args: unknown[]) => unknown);
    // Wire Celo's queries to succeed via the prototype mock.
    setupSuccessfulMock();

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    const monad = results.find((r) => r.network.id === "monad-mainnet")!;

    // Celo path unaffected.
    expect(celo.error).toBeNull();
    expect(celo.fees).not.toBeNull();
    expect(celo.feeTransfers).toHaveLength(1);

    // Monad: outer allSettled mapped the constructor throw to result.error.
    expect(monad.error).toBe(ctorErr);
    expect(monad.feesError).toBeNull(); // outer-channel error, not fees-channel
    expect(monad.fees).toBeNull();
    expect(monad.feeTransfers).toHaveLength(0);
    expect(monad.poolLabels.size).toBe(0);
    expect(monad.network.id).toBe("monad-mainnet");
  });

  it("per-chain feesError does not bleed across networks", async () => {
    // Celo: rates query rejects → feesError promoted.
    // Monad: all queries succeed → feesError null.
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((...args: unknown[]) => {
      const constructedUrls = (
        GraphQLClient as ReturnType<typeof vi.fn>
      ).mock.calls.map((c: unknown[]) => c[0] as string);
      const lastUrl = constructedUrls[constructedUrls.length - 1] ?? "";
      const query = extractQuery(args[0]);

      if (lastUrl.includes("celo")) {
        if (query.includes("OracleRates"))
          return Promise.reject(new Error("celo rates down"));
        if (query.includes("ProtocolFeeTransfer"))
          return Promise.resolve({ ProtocolFeeTransfer: [USDC_TRANSFER] });
        if (query.includes("PoolLabelsAll"))
          return Promise.resolve({ Pool: [POOL_LABEL] });
      }

      // Monad: all succeed.
      if (query.includes("OracleRates"))
        return Promise.resolve({ Pool: [ORACLE_POOL] });
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [USDC_TRANSFER] });
      if (query.includes("PoolLabelsAll"))
        return Promise.resolve({ Pool: [POOL_LABEL] });
      return Promise.resolve({});
    });

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    const monad = results.find((r) => r.network.id === "monad-mainnet")!;

    expect(celo.feesError).not.toBeNull();
    expect(celo.fees).toBeNull();

    // Monad's feesError must remain null — errors are strictly per-network.
    expect(monad.feesError).toBeNull();
    expect(monad.fees).not.toBeNull();
  });
});
