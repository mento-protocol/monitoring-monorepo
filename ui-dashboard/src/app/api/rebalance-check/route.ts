import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  checkRebalanceStatus,
  type RebalanceCheckResult,
} from "@/lib/rebalance-check";
import { NETWORKS, isConfiguredNetworkId } from "@/lib/networks";
import { isValidAddress } from "@/lib/format";
import { redactRpcUrl } from "@/lib/redact-rpc-url";

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

type DedupOutcome<T> =
  | { kind: "hit"; result: T }
  | { kind: "saturated" }
  | { kind: "fresh"; promise: Promise<T> };

/**
 * Cache + in-flight dedup for read-only GET responses. Encapsulates the
 * `inFlight.set/delete` mutations so the GET handler has no observable
 * side effects of its own — only `getOrDispatch` does, and it's an
 * idempotent read-through cache primitive.
 */
function getOrDispatch(
  key: string,
  produce: () => Promise<RebalanceCheckResult>,
): DedupOutcome<RebalanceCheckResult> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { kind: "hit", result: cached.result };
  }
  const existing = inFlight.get(key);
  if (existing) return { kind: "fresh", promise: existing };
  if (inFlight.size >= INFLIGHT_MAX_ENTRIES) return { kind: "saturated" };

  const promise = produce()
    .then((result) => {
      setCacheEntry(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { kind: "fresh", promise };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const network = req.nextUrl.searchParams.get("network");
  const pool = req.nextUrl.searchParams.get("pool");
  const strategy = req.nextUrl.searchParams.get("strategy");

  if (!network || !isConfiguredNetworkId(network)) {
    return NextResponse.json({ error: "Invalid network" }, { status: 400 });
  }
  if (!pool || !isValidAddress(pool)) {
    return NextResponse.json(
      { error: "Invalid pool address" },
      { status: 400 },
    );
  }
  if (!strategy || !isValidAddress(strategy)) {
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

  const outcome = getOrDispatch(key, () =>
    runWithRetry(pool, strategy, rpcUrl),
  );
  if (outcome.kind === "hit") {
    return NextResponse.json(outcome.result);
  }
  if (outcome.kind === "saturated") {
    return NextResponse.json({ error: "Server busy" }, { status: 503 });
  }

  try {
    const result = await outcome.promise;
    return NextResponse.json(result);
  } catch (err) {
    // Ship the upstream error to Sentry after redacting the RPC URL from
    // the error message. Providers like Infura/Alchemy embed API keys in
    // the URL PATH (e.g. /v3/<key>), which the generic query-string
    // scrubber in sentry.shared.ts won't catch. Replace the exact rpcUrl
    // with a placeholder so the key can't leak via err.message. Return a
    // stable public string so the endpoint's contract doesn't drift with
    // provider error phrasing and nothing sensitive leaks to the browser.
    Sentry.captureException(redactRpcUrl(err, rpcUrl), {
      tags: { route: "rebalance-check", network },
    });
    console.error("[rebalance-check]", network, pool, err);
    return NextResponse.json({ error: "Upstream RPC error" }, { status: 502 });
  }
}

// Lifted to `@/lib/redact-rpc-url` so future routes that need the same
// redaction discipline don't re-implement it. Re-exported here for
// backwards-compat with `__tests__/redact-rpc-url.test.ts`.
export { redactRpcUrl, containsRpcUrl } from "@/lib/redact-rpc-url";

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
