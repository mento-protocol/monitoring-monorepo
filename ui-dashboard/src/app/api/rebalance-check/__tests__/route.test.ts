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

async function loadRoute(): Promise<{
  GET: (req: NextRequest) => Promise<Response>;
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

  it("returns 400 when the configured network has no rpcUrl", async () => {
    // The network is registered (passes isConfiguredNetworkId) but its
    // rpcUrl is unset — we can't proxy the check, so refuse up front with
    // a stable error payload rather than reaching the eth_call path.
    vi.resetModules();
    vi.doMock("@/lib/networks", () => ({
      NETWORKS: {
        [MOCK_NETWORK_ID]: {
          id: MOCK_NETWORK_ID,
          rpcUrl: undefined,
        },
      },
      isConfiguredNetworkId: (v: string) => v === MOCK_NETWORK_ID,
    }));
    vi.doMock("@/lib/rebalance-check", () => ({
      checkRebalanceStatus: mockCheckRebalanceStatus,
    }));
    const { GET } = (await import("../route")) as {
      GET: (req: NextRequest) => Promise<Response>;
    };

    const req = new NextRequest(
      buildUrl({
        network: MOCK_NETWORK_ID,
        pool: POOL,
        strategy: STRATEGY,
      }),
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `No RPC URL configured for ${MOCK_NETWORK_ID}`,
    });
    // Refused before the eth_call path — checkRebalanceStatus must not run.
    expect(mockCheckRebalanceStatus).not.toHaveBeenCalled();
  });
});

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

  it("populates cache BEFORE releasing inFlight (race-ordering guard)", async () => {
    // Regression guard: cache.set must happen inside the .then() that runs
    // BEFORE .finally() deletes the inFlight entry. If someone reorders those
    // two callbacks, a 3rd request arriving right after the in-flight promise
    // settles would see neither inFlight nor cache populated and fire a
    // duplicate upstream RPC. Behavioral invariant checked here:
    // upstream call count stays at 1 across all three requests.
    const { GET } = await loadRoute();
    const deferred = makeDeferred<typeof BASE_RESULT>();
    mockCheckRebalanceStatus.mockReturnValueOnce(deferred.promise);

    const params = {
      network: MOCK_NETWORK_ID,
      pool: POOL,
      strategy: STRATEGY,
    };

    // R1 and R2 are concurrent → both attach to the same inFlight promise.
    const r1 = GET(new NextRequest(buildUrl(params)));
    const r2 = GET(new NextRequest(buildUrl(params)));

    // Release the upstream call. This schedules the route's .then/.finally
    // microtasks — when they run, cache.set must happen before inFlight.delete.
    deferred.resolve(BASE_RESULT);
    await Promise.all([r1, r2]);

    // R3 arrives AFTER R1/R2 settle — if cache was populated before inFlight
    // was cleared, this is a cache hit and upstream is NOT re-invoked.
    const r3 = await GET(new NextRequest(buildUrl(params)));
    expect(r3.status).toBe(200);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(1);
  });
});

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
    // Public error string is a stable sentinel — raw upstream messages (RPC
    // URLs, provider wording) stay in server logs only. See route.ts.
    expect(await res.json()).toEqual({ error: "Upstream RPC error" });
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

describe("GET /api/rebalance-check — DoS caps", () => {
  // Helper: build a distinct pool address. We keep strategy fixed and vary
  // the pool so each request maps to a fresh cache key.
  function makePool(i: number): string {
    // 40-char hex — pad i across the tail so each index yields a unique addr.
    const tail = i.toString(16).padStart(40, "0");
    return "0x" + tail;
  }

  it("evicts the oldest entry once cache reaches 1024 (FIFO)", async () => {
    const { GET } = await loadRoute();
    // Each request resolves immediately with the base result, populating cache.
    mockCheckRebalanceStatus.mockImplementation(async () => BASE_RESULT);

    // Fill cache to exactly 1024 entries.
    for (let i = 0; i < 1024; i++) {
      const res = await GET(
        new NextRequest(
          buildUrl({
            network: MOCK_NETWORK_ID,
            pool: makePool(i),
            strategy: STRATEGY,
          }),
        ),
      );
      expect(res.status).toBe(200);
    }

    // First pool (pool-0) should still be cached — verify a repeat hit doesn't
    // re-invoke upstream.
    const callsBeforeEvict = mockCheckRebalanceStatus.mock.calls.length;
    const hit = await GET(
      new NextRequest(
        buildUrl({
          network: MOCK_NETWORK_ID,
          pool: makePool(0),
          strategy: STRATEGY,
        }),
      ),
    );
    expect(hit.status).toBe(200);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(callsBeforeEvict);

    // Insert the 1025th distinct entry — this must evict pool-0 (oldest).
    const overflow = await GET(
      new NextRequest(
        buildUrl({
          network: MOCK_NETWORK_ID,
          pool: makePool(9999),
          strategy: STRATEGY,
        }),
      ),
    );
    expect(overflow.status).toBe(200);

    // Now pool-0 should miss → re-invoke upstream exactly once more.
    const countAfterOverflow = mockCheckRebalanceStatus.mock.calls.length;
    const missAfterEvict = await GET(
      new NextRequest(
        buildUrl({
          network: MOCK_NETWORK_ID,
          pool: makePool(0),
          strategy: STRATEGY,
        }),
      ),
    );
    expect(missAfterEvict.status).toBe(200);
    expect(mockCheckRebalanceStatus).toHaveBeenCalledTimes(
      countAfterOverflow + 1,
    );
  });

  it("rejects with 503 when inFlight reaches 64 concurrent entries", async () => {
    const { GET } = await loadRoute();
    // Keep every upstream call pending so inFlight fills up without draining.
    const deferreds: Array<
      ReturnType<typeof makeDeferred<typeof BASE_RESULT>>
    > = [];
    mockCheckRebalanceStatus.mockImplementation(() => {
      const d = makeDeferred<typeof BASE_RESULT>();
      deferreds.push(d);
      return d.promise;
    });

    // Fire 64 concurrent requests for distinct keys — fills inFlight to cap.
    const pending: Array<Promise<Response>> = [];
    for (let i = 0; i < 64; i++) {
      pending.push(
        GET(
          new NextRequest(
            buildUrl({
              network: MOCK_NETWORK_ID,
              pool: makePool(i),
              strategy: STRATEGY,
            }),
          ),
        ),
      );
    }

    // 65th distinct key — should be rejected with 503 immediately.
    const overflow = await GET(
      new NextRequest(
        buildUrl({
          network: MOCK_NETWORK_ID,
          pool: makePool(500),
          strategy: STRATEGY,
        }),
      ),
    );
    expect(overflow.status).toBe(503);
    expect(await overflow.json()).toEqual({ error: "Server busy" });

    // Resolve everything so the test cleans up (pending promises don't leak
    // across tests thanks to vi.resetModules() in loadRoute, but being tidy).
    for (const d of deferreds) d.resolve(BASE_RESULT);
    await Promise.all(pending);
  });
});
