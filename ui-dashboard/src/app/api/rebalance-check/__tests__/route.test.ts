import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above any import of the route module so the route's
// module-level `cache` and `inFlight` maps are fresh per `vi.resetModules()`.
// ---------------------------------------------------------------------------

const MOCK_NETWORK_ID = "celo-mainnet";
const MOCK_RPC_URL = "https://forno.celo.org";

vi.mock("@/lib/networks", () => ({
  NETWORKS: {
    [MOCK_NETWORK_ID]: {
      id: MOCK_NETWORK_ID,
      rpcUrl: MOCK_RPC_URL,
    },
  },
  isConfiguredNetworkId: (v: string) => v === MOCK_NETWORK_ID,
}));

const mockCheckRebalanceStatus = vi.fn();
vi.mock("@/lib/rebalance-check", () => ({
  checkRebalanceStatus: mockCheckRebalanceStatus,
}));

const POOL = "0x" + "a".repeat(40);
const STRATEGY = "0x" + "b".repeat(40);

const BASE_RESULT = {
  canRebalance: true,
  message: "Rebalance is currently possible",
  rawError: null,
  strategyType: "reserve" as const,
  enrichment: null,
};

function buildUrl(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.set(k, v);
  }
  return `http://localhost/api/rebalance-check?${usp.toString()}`;
}

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Per-test module reset — keeps the route's `cache` and `inFlight` maps clean.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadRoute(): Promise<{
  GET: (req: NextRequest) => Promise<any>;
}> {
  vi.resetModules();
  // Re-register mocks after resetModules — resetModules clears them.
  vi.doMock("@/lib/networks", () => ({
    NETWORKS: {
      [MOCK_NETWORK_ID]: {
        id: MOCK_NETWORK_ID,
        rpcUrl: MOCK_RPC_URL,
      },
    },
    isConfiguredNetworkId: (v: string) => v === MOCK_NETWORK_ID,
  }));
  vi.doMock("@/lib/rebalance-check", () => ({
    checkRebalanceStatus: mockCheckRebalanceStatus,
  }));
  return (await import("../route")) as {
    GET: (req: NextRequest) => Promise<Response>;
  };
}

beforeEach(() => {
  mockCheckRebalanceStatus.mockReset();
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("GET /api/rebalance-check — validation", () => {
  it("returns 400 when network is missing", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(buildUrl({ pool: POOL, strategy: STRATEGY }));
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid network" });
  });

  it("returns 400 when network is not configured", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(
      buildUrl({ network: "bogus-net", pool: POOL, strategy: STRATEGY }),
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid network" });
  });

  it("returns 400 when pool is missing", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(
      buildUrl({ network: MOCK_NETWORK_ID, strategy: STRATEGY }),
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid pool address" });
  });

  it("returns 400 when pool is not a valid address", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(
      buildUrl({
        network: MOCK_NETWORK_ID,
        pool: "not-an-address",
        strategy: STRATEGY,
      }),
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid pool address" });
  });

  it("returns 400 when strategy is missing", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(
      buildUrl({ network: MOCK_NETWORK_ID, pool: POOL }),
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid strategy address" });
  });

  it("returns 400 when strategy is not a valid address", async () => {
    const { GET } = await loadRoute();
    const req = new NextRequest(
      buildUrl({
        network: MOCK_NETWORK_ID,
        pool: POOL,
        strategy: "0xNotHex",
      }),
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid strategy address" });
  });
});

// ---------------------------------------------------------------------------
// Happy path + caching
// ---------------------------------------------------------------------------

describe("GET /api/rebalance-check — happy path", () => {
  it("calls checkRebalanceStatus once and returns its result as JSON", async () => {
    const { GET } = await loadRoute();
    mockCheckRebalanceStatus.mockResolvedValueOnce(BASE_RESULT);

    const req = new NextRequest(
      buildUrl({
        network: MOCK_NETWORK_ID,
        pool: POOL,
        strategy: STRATEGY,
      }),
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BASE_RESULT);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(1);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledWith(
      POOL,
      STRATEGY,
      MOCK_RPC_URL,
    );
  });

  it("serves a cache hit on the second call (same key)", async () => {
    const { GET } = await loadRoute();
    mockCheckRebalanceStatus.mockResolvedValueOnce(BASE_RESULT);

    const params = {
      network: MOCK_NETWORK_ID,
      pool: POOL,
      strategy: STRATEGY,
    };

    const res1 = await GET(new NextRequest(buildUrl(params)));
    expect(res1.status).toBe(200);

    const res2 = await GET(new NextRequest(buildUrl(params)));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual(BASE_RESULT);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(1);
  });

  it("treats the cache key as case-insensitive on pool and strategy", async () => {
    const { GET } = await loadRoute();
    mockCheckRebalanceStatus.mockResolvedValueOnce(BASE_RESULT);

    const res1 = await GET(
      new NextRequest(
        buildUrl({
          network: MOCK_NETWORK_ID,
          pool: POOL.toLowerCase(),
          strategy: STRATEGY.toLowerCase(),
        }),
      ),
    );
    expect(res1.status).toBe(200);

    // Same addresses but upper-cased hex digits — should hit the cache.
    const res2 = await GET(
      new NextRequest(
        buildUrl({
          network: MOCK_NETWORK_ID,
          pool: "0x" + "A".repeat(40),
          strategy: "0x" + "B".repeat(40),
        }),
      ),
    );
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual(BASE_RESULT);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// In-flight dedup (concurrent calls)
// ---------------------------------------------------------------------------

describe("GET /api/rebalance-check — in-flight dedup", () => {
  it("deduplicates two concurrent calls for the same key", async () => {
    const { GET } = await loadRoute();
    const deferred = makeDeferred<typeof BASE_RESULT>();
    mockCheckRebalanceStatus.mockReturnValueOnce(deferred.promise);

    const params = {
      network: MOCK_NETWORK_ID,
      pool: POOL,
      strategy: STRATEGY,
    };

    const p1 = GET(new NextRequest(buildUrl(params)));
    const p2 = GET(new NextRequest(buildUrl(params)));

    // Both requests should now be waiting on the same in-flight promise.
    deferred.resolve(BASE_RESULT);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await res1.json()).toEqual(BASE_RESULT);
    expect(await res2.json()).toEqual(BASE_RESULT);

    // checkRebalanceStatus must be invoked exactly once despite two concurrent
    // requests — this is the core dedup guarantee.
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit retry + non-retryable errors
// ---------------------------------------------------------------------------

describe("GET /api/rebalance-check — retry behavior", () => {
  it("retries once on a rate-limit error and returns the retry result", async () => {
    const { GET } = await loadRoute();
    mockCheckRebalanceStatus
      .mockRejectedValueOnce(new Error("rate-limit exceeded"))
      .mockResolvedValueOnce(BASE_RESULT);

    const req = new NextRequest(
      buildUrl({
        network: MOCK_NETWORK_ID,
        pool: POOL,
        strategy: STRATEGY,
      }),
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BASE_RESULT);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on non-rate-limit errors and returns 502", async () => {
    const { GET } = await loadRoute();
    mockCheckRebalanceStatus.mockRejectedValueOnce(
      new Error("execution reverted"),
    );

    const req = new NextRequest(
      buildUrl({
        network: MOCK_NETWORK_ID,
        pool: POOL,
        strategy: STRATEGY,
      }),
    );
    const res = await GET(req);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "execution reverted" });
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed calls (next call re-invokes checkRebalanceStatus)", async () => {
    const { GET } = await loadRoute();
    mockCheckRebalanceStatus
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockResolvedValueOnce(BASE_RESULT);

    const params = {
      network: MOCK_NETWORK_ID,
      pool: POOL,
      strategy: STRATEGY,
    };

    const res1 = await GET(new NextRequest(buildUrl(params)));
    expect(res1.status).toBe(502);

    // Failed calls must not populate the cache — next request should re-invoke.
    const res2 = await GET(new NextRequest(buildUrl(params)));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual(BASE_RESULT);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// inFlight cleared after settled request
// ---------------------------------------------------------------------------

describe("GET /api/rebalance-check — inFlight cleanup", () => {
  it("clears inFlight after a settled request so the next call goes through cache", async () => {
    const { GET } = await loadRoute();
    mockCheckRebalanceStatus.mockResolvedValueOnce(BASE_RESULT);

    const params = {
      network: MOCK_NETWORK_ID,
      pool: POOL,
      strategy: STRATEGY,
    };

    // First request resolves — this must populate cache AND clear inFlight.
    const res1 = await GET(new NextRequest(buildUrl(params)));
    expect(res1.status).toBe(200);

    // If inFlight was leaked, a second cached call would hang waiting on the
    // stale promise. It resolves instantly ⇒ cache path was taken.
    const res2 = await GET(new NextRequest(buildUrl(params)));
    expect(res2.status).toBe(200);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(1);
  });

  it("clears inFlight after a failed (non-retryable) request", async () => {
    const { GET } = await loadRoute();
    mockCheckRebalanceStatus
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockResolvedValueOnce(BASE_RESULT);

    const params = {
      network: MOCK_NETWORK_ID,
      pool: POOL,
      strategy: STRATEGY,
    };

    const res1 = await GET(new NextRequest(buildUrl(params)));
    expect(res1.status).toBe(502);

    // inFlight must have been cleared — otherwise subsequent call would reuse
    // the rejected promise and return 502 without calling checkRebalanceStatus
    // again. We expect a fresh invocation.
    const res2 = await GET(new NextRequest(buildUrl(params)));
    expect(res2.status).toBe(200);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(2);
  });
});
