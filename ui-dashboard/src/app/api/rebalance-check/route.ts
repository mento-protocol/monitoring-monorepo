import { NextRequest, NextResponse } from "next/server";
import {
  checkRebalanceStatus,
  type RebalanceCheckResult,
} from "@/lib/rebalance-check";
import { NETWORKS, isConfiguredNetworkId } from "@/lib/networks";

const CACHE_TTL_MS = 30_000;
const RATE_LIMIT_RETRY_DELAY_MS = 500;

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
    pending = runWithRetry(pool, strategy, rpcUrl).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
  }

  try {
    const result = await pending;
    cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
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
  return /rate.?limit|429|too many requests/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
