/**
 * Resolves a VirtualPool address to its underlying v2 BiPoolManager exchange
 * config. The pool detail page calls this to render reserves, bucket cadence,
 * oracle feed, and deprecation status without needing to touch RPC from the
 * browser. Cache TTL: 30s — bucket cadence on Celo is 6 minutes, so we're
 * stale by at most one cycle. Mirrors the rebalance-check route's caching
 * pattern.
 */
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  resolveV2ExchangeConfig,
  serializeV2ExchangeConfig,
  type ResolveV2Result,
  type V2ExchangeConfigResponse,
} from "@/lib/v2-exchange-config";
import { networkForChainId } from "@/lib/networks";
import { isValidAddress } from "@/lib/format";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 1024;
const INFLIGHT_MAX_ENTRIES = 64;

type CacheEntry = {
  result: ResolveV2Result;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ResolveV2Result>>();

function setCacheEntry(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ chainId: string; poolAddress: string }> },
): Promise<NextResponse> {
  const { chainId: chainIdStr, poolAddress } = await ctx.params;
  const chainId = Number(chainIdStr);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }
  if (!isValidAddress(poolAddress)) {
    return NextResponse.json(
      { error: "Invalid pool address" },
      { status: 400 },
    );
  }

  const network = networkForChainId(chainId);
  const rpcUrl = network?.rpcUrl;
  if (!network || !rpcUrl) {
    return NextResponse.json(
      { error: `No RPC URL configured for chain ${chainId}` },
      { status: 400 },
    );
  }

  const key = `${chainId}:${poolAddress.toLowerCase()}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return NextResponse.json(serializeResult(cached.result));
  }

  let pending = inFlight.get(key);
  if (!pending) {
    if (inFlight.size >= INFLIGHT_MAX_ENTRIES) {
      return NextResponse.json({ error: "Server busy" }, { status: 503 });
    }
    pending = resolveV2ExchangeConfig(poolAddress, rpcUrl)
      .then((result) => {
        setCacheEntry(key, {
          result,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return result;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, pending);
  }

  try {
    const result = await pending;
    return NextResponse.json(serializeResult(result));
  } catch (err) {
    // Forno doesn't embed secrets in URLs; if other RPC providers (with
    // path-embedded API keys) are added later, we'll need to redact like
    // rebalance-check/route.ts does.
    Sentry.captureException(err, {
      tags: { route: "v2-exchange-config", chainId: String(chainId) },
    });
    console.error("[v2-exchange-config]", chainId, poolAddress, err);
    return NextResponse.json({ error: "Upstream RPC error" }, { status: 502 });
  }
}

function serializeResult(result: ResolveV2Result): V2ExchangeConfigResponse {
  return result.ok
    ? { ok: true, config: serializeV2ExchangeConfig(result.config) }
    : { ok: false, reason: result.reason };
}
