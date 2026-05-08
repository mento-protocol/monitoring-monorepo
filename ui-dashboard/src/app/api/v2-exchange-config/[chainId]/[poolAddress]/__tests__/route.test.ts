import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mocks must be hoisted ABOVE the route module so each `vi.resetModules()`
// re-creates the route's module-level cache + inFlight maps fresh.

const MAINNET_ID = "celo-mainnet";
const LOCAL_ID = "celo-mainnet-local";
const MAINNET_CHAIN_ID = 42220;
const LOCAL_CHAIN_ID = 42220; // intentionally same chainId
const MAINNET_RPC = "https://forno.celo.org";
const LOCAL_RPC = "http://localhost:8545";

const mockResolveV2ExchangeConfig = vi.fn();
const mockSentryCaptureMessage = vi.fn();
const mockSentryCaptureException = vi.fn();

const NETWORKS_MOCK = {
  [MAINNET_ID]: {
    id: MAINNET_ID,
    chainId: MAINNET_CHAIN_ID,
    rpcUrl: MAINNET_RPC,
  },
  [LOCAL_ID]: {
    id: LOCAL_ID,
    chainId: LOCAL_CHAIN_ID,
    rpcUrl: LOCAL_RPC,
  },
} as const;

vi.mock("@/lib/networks", () => ({
  NETWORKS: NETWORKS_MOCK,
  isConfiguredNetworkId: (v: string) => v === MAINNET_ID || v === LOCAL_ID,
  networkForChainId: (cid: number) =>
    cid === MAINNET_CHAIN_ID ? NETWORKS_MOCK[MAINNET_ID] : null,
}));

vi.mock("@/lib/v2-exchange-config", () => ({
  resolveV2ExchangeConfig: mockResolveV2ExchangeConfig,
  // Use the real serializer so the route's serialization layer is exercised.
  serializeV2ExchangeConfig: (c: unknown) => c,
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: mockSentryCaptureMessage,
  captureException: mockSentryCaptureException,
}));

const POOL = "0x" + "a".repeat(40);

function buildUrl(
  chainId: number,
  pool: string,
  searchParams: Record<string, string> = {},
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) usp.set(k, v);
  const qs = usp.toString();
  return `http://localhost/api/v2-exchange-config/${chainId}/${pool}${qs ? "?" + qs : ""}`;
}

function ctxFor(
  chainId: number,
  poolAddress: string,
): { params: Promise<{ chainId: string; poolAddress: string }> } {
  return {
    params: Promise.resolve({ chainId: String(chainId), poolAddress }),
  };
}

async function loadRoute(): Promise<{
  GET: (
    req: NextRequest,
    ctx: { params: Promise<{ chainId: string; poolAddress: string }> },
  ) => Promise<Response>;
}> {
  vi.resetModules();
  // Re-register mocks after resetModules.
  vi.doMock("@/lib/networks", () => ({
    NETWORKS: NETWORKS_MOCK,
    isConfiguredNetworkId: (v: string) => v === MAINNET_ID || v === LOCAL_ID,
    networkForChainId: (cid: number) =>
      cid === MAINNET_CHAIN_ID ? NETWORKS_MOCK[MAINNET_ID] : null,
  }));
  vi.doMock("@/lib/v2-exchange-config", () => ({
    resolveV2ExchangeConfig: mockResolveV2ExchangeConfig,
    serializeV2ExchangeConfig: (c: unknown) => c,
  }));
  vi.doMock("@sentry/nextjs", () => ({
    captureMessage: mockSentryCaptureMessage,
    captureException: mockSentryCaptureException,
  }));
  return (await import("../route")) as {
    GET: (
      req: NextRequest,
      ctx: { params: Promise<{ chainId: string; poolAddress: string }> },
    ) => Promise<Response>;
  };
}

beforeEach(() => {
  mockResolveV2ExchangeConfig.mockReset();
  mockSentryCaptureMessage.mockReset();
  mockSentryCaptureException.mockReset();
});

describe("GET /api/v2-exchange-config — validation", () => {
  it("returns 400 for non-integer chainId", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL));
    const res = await GET(req, {
      params: Promise.resolve({ chainId: "not-a-number", poolAddress: POOL }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid chainId" });
  });

  it("returns 400 for invalid address", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(buildUrl(MAINNET_CHAIN_ID, "0xnope"));
    const res = await GET(req, ctxFor(MAINNET_CHAIN_ID, "0xnope"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid pool address" });
  });

  it("returns 400 when ?network is invalid", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(
      buildUrl(MAINNET_CHAIN_ID, POOL, { network: "bogus-net" }),
    );
    const res = await GET(req, ctxFor(MAINNET_CHAIN_ID, POOL));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid network" });
  });

  it("returns 400 when ?network's chainId disagrees with the path chainId", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(
      buildUrl(143 /* monad chainId */, POOL, { network: MAINNET_ID }),
    );
    const res = await GET(req, ctxFor(143, POOL));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "network does not match chainId",
    });
  });

  it("returns 400 when chainId has no canonical mapping AND ?network missing", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(buildUrl(999, POOL));
    const res = await GET(req, ctxFor(999, POOL));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No network configured/);
  });
});

describe("GET /api/v2-exchange-config — routing", () => {
  it("falls back to canonical mainnet when ?network is omitted", async () => {
    mockResolveV2ExchangeConfig.mockResolvedValueOnce({
      ok: false,
      reason: "no_bytecode",
    });
    const { GET } = await loadRoute();
    const req = new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL));
    const res = await GET(req, ctxFor(MAINNET_CHAIN_ID, POOL));
    expect(res.status).toBe(200);
    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledWith(
      POOL,
      MAINNET_RPC,
      MAINNET_CHAIN_ID,
    );
  });

  it("uses the explicit ?network's RPC URL even when a canonical exists", async () => {
    mockResolveV2ExchangeConfig.mockResolvedValueOnce({
      ok: false,
      reason: "no_bytecode",
    });
    const { GET } = await loadRoute();
    const req = new NextRequest(
      buildUrl(LOCAL_CHAIN_ID, POOL, { network: LOCAL_ID }),
    );
    const res = await GET(req, ctxFor(LOCAL_CHAIN_ID, POOL));
    expect(res.status).toBe(200);
    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledWith(
      POOL,
      LOCAL_RPC,
      LOCAL_CHAIN_ID,
    );
  });
});

describe("GET /api/v2-exchange-config — caching + failure semantics", () => {
  it("returns 502 when resolveV2ExchangeConfig returns rpc_failed and does NOT cache", async () => {
    mockResolveV2ExchangeConfig.mockResolvedValue({
      ok: false,
      reason: "rpc_failed",
    });

    const { GET } = await loadRoute();
    const req = new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL));
    const res = await GET(req, ctxFor(MAINNET_CHAIN_ID, POOL));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Upstream RPC error" });
    expect(mockSentryCaptureMessage).toHaveBeenCalled();

    // Second request must hit the resolver again (not served from cache).
    const req2 = new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL));
    await GET(req2, ctxFor(MAINNET_CHAIN_ID, POOL));
    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledTimes(2);
  });

  it("caches successful (ok:true) results — second request skips resolver", async () => {
    mockResolveV2ExchangeConfig.mockResolvedValue({
      ok: true,
      config: {
        exchangeId: "0xdeadbeef",
        exchangeProvider: "0xdead",
        asset0: "0x0",
        asset1: "0x0",
        pricingModule: "0x0",
        pricingModuleName: null,
        spread: "0",
        referenceRateFeedID: "0x0",
        referenceRateResetFrequency: "0",
        minimumReports: "0",
        stablePoolResetSize: "0",
        bucket0: "0",
        bucket1: "0",
        lastBucketUpdate: "0",
        isDeprecated: false,
      },
    });

    const { GET } = await loadRoute();

    const req = new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL));
    const res = await GET(req, ctxFor(MAINNET_CHAIN_ID, POOL));
    expect(res.status).toBe(200);

    const req2 = new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL));
    const res2 = await GET(req2, ctxFor(MAINNET_CHAIN_ID, POOL));
    expect(res2.status).toBe(200);
    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledTimes(1);
  });

  it("caches stable misses (no_bytecode, not_a_virtual_pool)", async () => {
    mockResolveV2ExchangeConfig.mockResolvedValue({
      ok: false,
      reason: "not_a_virtual_pool",
    });
    const { GET } = await loadRoute();

    await GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
      ctxFor(MAINNET_CHAIN_ID, POOL),
    );
    await GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
      ctxFor(MAINNET_CHAIN_ID, POOL),
    );

    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledTimes(1);
  });

  it("does NOT share cache entries between mainnet and local-mainnet (same chainId, different network ids)", async () => {
    mockResolveV2ExchangeConfig.mockResolvedValue({
      ok: false,
      reason: "no_bytecode",
    });

    const { GET } = await loadRoute();

    // Mainnet (canonical fallback)
    await GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
      ctxFor(MAINNET_CHAIN_ID, POOL),
    );
    // Local (explicit ?network)
    await GET(
      new NextRequest(buildUrl(LOCAL_CHAIN_ID, POOL, { network: LOCAL_ID })),
      ctxFor(LOCAL_CHAIN_ID, POOL),
    );

    // Must have hit the resolver twice (different cache keys, different RPCs).
    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledTimes(2);
    expect(mockResolveV2ExchangeConfig).toHaveBeenNthCalledWith(
      1,
      POOL,
      MAINNET_RPC,
      MAINNET_CHAIN_ID,
    );
    expect(mockResolveV2ExchangeConfig).toHaveBeenNthCalledWith(
      2,
      POOL,
      LOCAL_RPC,
      LOCAL_CHAIN_ID,
    );
  });

  it("returns 502 + Sentry-capture when resolveV2ExchangeConfig throws", async () => {
    mockResolveV2ExchangeConfig.mockRejectedValueOnce(
      new Error("unexpected internal error"),
    );

    const { GET } = await loadRoute();
    const req = new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL));
    const res = await GET(req, ctxFor(MAINNET_CHAIN_ID, POOL));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Upstream RPC error" });
    expect(mockSentryCaptureException).toHaveBeenCalled();
  });
});

describe("GET /api/v2-exchange-config — in-flight dedup", () => {
  it("dedupes concurrent requests for the same key", async () => {
    let resolveResolver!: (v: unknown) => void;
    const pending = new Promise((res) => {
      resolveResolver = res;
    });
    mockResolveV2ExchangeConfig.mockReturnValueOnce(pending);

    const { GET } = await loadRoute();

    // Fire two concurrent requests; the second should join the first's promise.
    const r1 = GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
      ctxFor(MAINNET_CHAIN_ID, POOL),
    );
    const r2 = GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
      ctxFor(MAINNET_CHAIN_ID, POOL),
    );

    resolveResolver({ ok: true, config: { isDeprecated: false } });
    await Promise.all([r1, r2]);

    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/v2-exchange-config — Sentry throttle", () => {
  it("fires Sentry once when N concurrent waiters share an rpc_failed in-flight promise", async () => {
    let resolveResolver!: (v: unknown) => void;
    const pending = new Promise((res) => {
      resolveResolver = res;
    });
    mockResolveV2ExchangeConfig.mockReturnValueOnce(pending);

    const { GET } = await loadRoute();

    // Three concurrent requests for the same pool — all join the same in-
    // flight promise. The fix moves the Sentry capture into the in-flight
    // resolver so it fires once per upstream call, not once per waiter.
    const reqs = [0, 0, 0].map(() =>
      GET(
        new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
        ctxFor(MAINNET_CHAIN_ID, POOL),
      ),
    );

    resolveResolver({ ok: false, reason: "rpc_failed" });
    const results = await Promise.all(reqs);

    expect(results.map((r) => r.status)).toEqual([502, 502, 502]);
    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledTimes(1);
    expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("throttles successive rpc_failed captures within the 5-minute window", async () => {
    mockResolveV2ExchangeConfig.mockResolvedValue({
      ok: false,
      reason: "rpc_failed",
    });
    const { GET } = await loadRoute();

    // First failure fires Sentry; rpc_failed isn't cached, so the second
    // request hits the resolver again — but the throttle should suppress
    // the second capture (both calls land within the 5-minute window).
    await GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
      ctxFor(MAINNET_CHAIN_ID, POOL),
    );
    await GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
      ctxFor(MAINNET_CHAIN_ID, POOL),
    );

    expect(mockResolveV2ExchangeConfig).toHaveBeenCalledTimes(2);
    expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("does not throttle captures across distinct cache keys", async () => {
    mockResolveV2ExchangeConfig.mockResolvedValue({
      ok: false,
      reason: "rpc_failed",
    });
    const { GET } = await loadRoute();
    const POOL_B = "0x" + "b".repeat(40);

    await GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL)),
      ctxFor(MAINNET_CHAIN_ID, POOL),
    );
    await GET(
      new NextRequest(buildUrl(MAINNET_CHAIN_ID, POOL_B)),
      ctxFor(MAINNET_CHAIN_ID, POOL_B),
    );

    // Distinct pools → distinct keys → both fire.
    expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(2);
  });
});
