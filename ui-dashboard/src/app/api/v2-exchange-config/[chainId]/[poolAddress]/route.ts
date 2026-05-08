/**
 * Resolves a VirtualPool address to its underlying v2 BiPoolManager exchange
 * config. The caller (the pool detail page) uses this to render reserves,
 * bucket cadence, oracle feed, and deprecation status without needing to
 * touch RPC from the browser.
 *
 * Cache TTL: 30s. The bucket reset cadence is 6 minutes on Celo, so 30s is
 * plenty fresh while keeping pageloads fast under traffic spikes. Mirrors
 * the rebalance-check route's caching/in-flight pattern.
 */
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  resolveV2ExchangeConfig,
  type ResolveV2Result,
  type V2ExchangeConfig,
} from "@/lib/v2-exchange-config";
import { networkForChainId } from "@/lib/networks";
import { isValidAddress } from "@/lib/format";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 1024;
const INFLIGHT_MAX_ENTRIES = 64;

type SerializedConfig = {
  exchangeId: string;
  exchangeProvider: string;
  asset0: string;
  asset1: string;
  pricingModule: string;
  pricingModuleName: string;
  spread: string;
  referenceRateFeedID: string;
  referenceRateResetFrequency: string;
  minimumReports: string;
  stablePoolResetSize: string;
  bucket0: string;
  bucket1: string;
  lastBucketUpdate: string;
  isDeprecated: boolean;
};

export type V2ExchangeConfigResponse =
  | { ok: true; config: SerializedConfig }
  | { ok: false; reason: "no_bytecode" | "not_a_virtual_pool" | "rpc_failed" };

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

// BigInts can't go through JSON.stringify — serialize as decimal strings.
// The client converts back to BigInt where needed.
function serializeResult(result: ResolveV2Result): {
  ok: boolean;
  config?: SerializedConfig;
  reason?: string;
} {
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, config: serializeConfig(result.config) };
}

function serializeConfig(c: V2ExchangeConfig): SerializedConfig {
  return {
    exchangeId: c.exchangeId,
    exchangeProvider: c.exchangeProvider,
    asset0: c.asset0,
    asset1: c.asset1,
    pricingModule: c.pricingModule,
    pricingModuleName: c.pricingModuleName,
    spread: c.spread.toString(),
    referenceRateFeedID: c.referenceRateFeedID,
    referenceRateResetFrequency: c.referenceRateResetFrequency.toString(),
    minimumReports: c.minimumReports.toString(),
    stablePoolResetSize: c.stablePoolResetSize.toString(),
    bucket0: c.bucket0.toString(),
    bucket1: c.bucket1.toString(),
    lastBucketUpdate: c.lastBucketUpdate.toString(),
    isDeprecated: c.isDeprecated,
  };
}
