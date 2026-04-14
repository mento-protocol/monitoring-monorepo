import { NextRequest, NextResponse } from "next/server";
import {
  checkRebalanceStatus,
  type RebalanceCheckResult,
} from "@/lib/rebalance-check";
import { NETWORKS, isConfiguredNetworkId } from "@/lib/networks";

const CACHE_TTL_MS = 30_000;
const RATE_LIMIT_RETRY_DELAY_MS = 500;
// Hard cap on cached (pool, strategy) pairs per warm instance. Cache keys are
// validated 0x addresses, but an attacker can still spray distinct pairs to
// grow the map indefinitely. FIFO eviction keeps memory bounded without
// pulling in an LRU dependency.
const CACHE_MAX_ENTRIES = 1024;
// Hard cap on concurrent upstream calls. Past this we reject fast with 503
// instead of queueing — the upstream RPC is the bottleneck anyway and
// unbounded queueing would just amplify a DoS.
const INFLIGHT_MAX_ENTRIES = 64;

type CacheEntry = {
  result: RebalanceCheckResult;
  expiresAt: number;
};

// Per-instance cache. Vercel functions share memory across warm invocations,
// so one instance serves many users from cache. Cross-instance misses are
// acceptable given a 30s TTL; promote to Redis if that stops being true.
const cache = new Map<string, CacheEntry>();

// Deduplicates concurrent in-flight requests for the same key so N simultaneous
// cache misses only trigger one upstream eth_call.
const inFlight = new Map<string, Promise<RebalanceCheckResult>>();

/** FIFO evict when full, then insert. Map iteration is insertion-ordered. */
function setCacheEntry(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, entry);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const network = req.nextUrl.searchParams.get("network");
  const pool = req.nextUrl.searchParams.get("pool");
  const strategy = req.nextUrl.searchParams.get("strategy");

  if (!network || !isConfiguredNetworkId(network)) {
    return NextResponse.json({ error: "Invalid network" }, { status: 400 });
  }
  if (!pool || !ADDRESS_RE.test(pool)) {
    return NextResponse.json(
      { error: "Invalid pool address" },
      { status: 400 },
    );
  }
  if (!strategy || !ADDRESS_RE.test(strategy)) {
    return NextResponse.json(
      { error: "Invalid strategy address" },
      { status: 400 },
    );
  }

  const rpcUrl = NETWORKS[network].rpcUrl;
  if (!rpcUrl) {
    return NextResponse.json(
      { error: `No RPC URL configured for ${network}` },
      { status: 400 },
    );
  }

  const key = `${network}:${pool.toLowerCase()}:${strategy.toLowerCase()}`;
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return NextResponse.json(cached.result);
  }

  let pending = inFlight.get(key);
  if (!pending) {
    // Refuse new upstream calls once we're saturated so attacker-controlled
    // keys can't blow memory/RPC quota. Existing in-flight keys still resolve.
    if (inFlight.size >= INFLIGHT_MAX_ENTRIES) {
      return NextResponse.json({ error: "Server busy" }, { status: 503 });
    }
    // Populate the cache INSIDE the promise chain (before .finally clears
    // inFlight) so we never leave a window where a new request sees neither
    // inFlight nor cache and fires a duplicate upstream RPC.
    pending = runWithRetry(pool, strategy, rpcUrl)
      .then((result) => {
        setCacheEntry(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
        return result;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, pending);
  }

  try {
    const result = await pending;
    return NextResponse.json(result);
  } catch (err) {
    console.error("[rebalance-check]", network, pool, err);
    const message = err instanceof Error ? err.message : "Upstream RPC error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

async function runWithRetry(
  pool: string,
  strategy: string,
  rpcUrl: string,
): Promise<RebalanceCheckResult> {
  try {
    return await checkRebalanceStatus(pool, strategy, rpcUrl);
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    return checkRebalanceStatus(pool, strategy, rpcUrl);
  }
}

function isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  // Mirror indexer-envio/src/rpc.ts RATE_LIMIT_RE so the retry heuristic
  // stays consistent with the upstream RPC client's detection.
  return /rate.?limit|request limit reached|429|too many requests|throttl/i.test(
    msg,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
