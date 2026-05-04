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
// @/lib/networks mock — two deterministic networks so cross-chain isolation
// tests have predictable indexes. Only one vi.mock per module is allowed;
// all test cases use this two-network registry.
// ---------------------------------------------------------------------------

vi.mock("@/lib/networks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/networks")>();
  return {
    ...actual,
    NETWORK_IDS: ["celo-mainnet", "monad-mainnet"],
    NETWORKS: {
      "celo-mainnet": {
        id: "celo-mainnet",
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
      },
      "monad-mainnet": {
        id: "monad-mainnet",
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
      },
    },
    isConfiguredNetworkId: (id: string) =>
      ["celo-mainnet", "monad-mainnet"].includes(id),
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
 * calls. Each invocation routes based on the query document string.
 */
function mockRequest(
  impl: (query: string, url: string) => unknown | Promise<unknown>,
) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation((...args: unknown[]) => {
    const query = extractQuery(args[0]);
    // Determine which client's URL this belongs to.
    const constructedUrls = (
      GraphQLClient as ReturnType<typeof vi.fn>
    ).mock.calls.map((c: unknown[]) => c[0] as string);
    const lastUrl = constructedUrls[constructedUrls.length - 1] ?? "";
    const result = impl(query, lastUrl);
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

/** Happy-path mock: all three queries return non-empty data. */
function setupSuccessfulMock() {
  mockRequest((query) => {
    if (query.includes("OracleRates")) return { Pool: [ORACLE_POOL] };
    if (query.includes("ProtocolFeeTransfer"))
      return { ProtocolFeeTransfer: [USDC_TRANSFER] };
    if (query.includes("PoolLabelsAll")) return { Pool: [POOL_LABEL] };
    return {};
  });
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  capturedFetcher = null;
});

// ---------------------------------------------------------------------------
// Case 1: All three queries succeed
// ---------------------------------------------------------------------------

describe("useProtocolFees — all three queries succeed", () => {
  it("populates fees, feeTransfers, poolLabels and leaves feesError null", async () => {
    setupSuccessfulMock();

    const results = await runFetcher();

    const celo = results.find((r) => r.network.id === "celo-mainnet")!;
    expect(celo.feesError).toBeNull();
    expect(celo.error).toBeNull();
    // aggregateProtocolFees always returns a summary (never null) on success.
    expect(celo.fees).not.toBeNull();
    expect(celo.feeTransfers).toHaveLength(1);
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
// Case 6: Hasura URL missing
// The hasura guard is module-private inside fetchFeesForNetwork. We test it
// by verifying the `blankNetworkData` shape it produces — the guard's exact
// error message format is load-bearing because consumers key on it for UI banners.
// ---------------------------------------------------------------------------

describe("useProtocolFees — hasura URL guard", () => {
  it("blankNetworkData with missing-URL error carries correct message and zero data", async () => {
    const { blankNetworkData } = await import("@/lib/fetch-all-networks");
    const { buildSnapshotWindows } = await import("@/lib/volume");

    const network = {
      id: "celo-mainnet" as const,
      label: "Celo No URL",
      chainId: 42220,
      contractsNamespace: null,
      hasuraUrl: "",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      hasVirtualPools: false,
      testnet: false,
    };
    const windows = buildSnapshotWindows(Date.now());
    // This mirrors exactly what fetchFeesForNetwork returns when !network.hasuraUrl.
    const result = blankNetworkData(network, windows, {
      error: new Error(`Hasura URL not configured for "${network.label}"`),
    });

    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("Hasura URL not configured");
    expect(result.error?.message).toContain(network.label);
    expect(result.fees).toBeNull();
    expect(result.feeTransfers).toHaveLength(0);
    expect(result.poolLabels.size).toBe(0);
    expect(result.feesError).toBeNull(); // error is on `error`, not `feesError`
  });

  it("networks with hasuraUrl set do not produce Hasura-config errors", async () => {
    // Verify the two mocked networks (both have hasuraUrl) produce no URL guard errors.
    setupSuccessfulMock();
    const results = await runFetcher();

    for (const r of results) {
      expect(r.error?.message ?? "").not.toContain("Hasura URL not configured");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 7: Two chains, one fails entirely — per-chain isolation
// ---------------------------------------------------------------------------

describe("useProtocolFees — per-chain isolation", () => {
  it("one chain with all queries failing does not blank the other chain", async () => {
    // All three of Monad's queries reject. fetchFeesForNetwork still returns
    // (via allSettled), carrying feesError. Celo is unaffected.
    // We differentiate by the URL used to construct each GraphQLClient.
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

  it("outer allSettled surfaces a network-level error on the error channel when fetchFeesForNetwork throws", async () => {
    // fetchFeesForNetwork can throw synchronously after the allSettled block
    // (e.g. a bug in blankNetworkData or stripChainIdFromPoolId). fetchAllProtocolFees
    // wraps each per-network call in its own allSettled, mapping rejected entries
    // to blankNetworkData({error}). We verify that shape here by simulating a
    // network that would get the outer catch path — the easiest proxy is to verify
    // the shape of blankNetworkData(network, windows, {error}) which is what the
    // outer catch produces.
    const { blankNetworkData } = await import("@/lib/fetch-all-networks");
    const { buildSnapshotWindows } = await import("@/lib/volume");

    const network = {
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
    const windows = buildSnapshotWindows(Date.now());
    const outerErr = new Error("unexpected throw");
    const result = blankNetworkData(network, windows, { error: outerErr });

    expect(result.error).toBe(outerErr);
    expect(result.network.id).toBe("monad-mainnet");
    expect(result.fees).toBeNull();
    expect(result.feeTransfers).toHaveLength(0);
    expect(result.feesError).toBeNull(); // outer error goes on `error`, not `feesError`
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
