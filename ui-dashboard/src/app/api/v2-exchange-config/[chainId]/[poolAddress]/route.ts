/**
 * Resolves a VirtualPool address to its underlying v2 BiPoolManager exchange
 * config. The pool detail page calls this to render reserves, bucket cadence,
 * oracle feed, and deprecation status without needing to touch RPC from the
 * browser. Cache TTL: 30s — bucket cadence on Celo is 6 minutes, so we're
 * stale by at most one cycle. Mirrors the rebalance-check route's caching
 * pattern.
 *
 * Routing keys on `network` (a configured network id like `celo-mainnet`),
 * not on chainId, because multiple networks can share a chainId (e.g.
 * `celo-mainnet` and `celo-mainnet-local` both resolve 42220 but talk to
 * different RPCs). The path-segment chainId is kept as a sanity check —
 * it must agree with the network's chainId — so existing inbound URLs that
 * include only the chainId can be migrated incrementally.
 */
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  resolveV2ExchangeConfig,
  serializeV2ExchangeConfig,
  type ResolveV2Result,
  type V2ExchangeConfigResponse,
} from "@/lib/v2-exchange-config";
import {
  NETWORKS,
  isConfiguredNetworkId,
  networkForChainId,
} from "@/lib/networks";
import { isValidAddress } from "@/lib/format";
import { redactRpcUrl } from "@/lib/redact-rpc-url";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 1024;
const INFLIGHT_MAX_ENTRIES = 64;
// Sentry capture throttle per cache key. The SWR hook polls every 60s, and
// `rpc_failed` results are intentionally not cached, so during a sustained
// upstream outage every poll cycle from every open tab would fire a
// separate Sentry event without this. 5 minutes is enough to surface a
// real incident without flooding — a longer outage still gets a steady
// trickle of captures so PagerDuty/triage knows it's still ongoing.
const SENTRY_MIN_INTERVAL_MS = 5 * 60_000;

// Cacheable degraded outcomes: reflect immutable on-chain truth (no contract,
// not a VP, governance-removed exchange). Transient `rpc_failed` is NOT
// cached — it would mask provider outages as "permanent" misses for 30s and
// silently bypass Sentry, hiding real upstream incidents.
type CacheableResult =
  | Extract<ResolveV2Result, { ok: true }>
  | {
      ok: false;
      reason: "no_bytecode" | "not_a_virtual_pool";
    };

type CacheEntry = {
  result: CacheableResult;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ResolveV2Result>>();
const lastSentryAt = new Map<string, number>();

function setCacheEntry(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

/** Throttled Sentry capture. Returns `true` when capture fired so callers
 *  can branch (e.g. log to console only on the throttled path). Capped at
 *  CACHE_MAX_ENTRIES with FIFO eviction — mirrors setCacheEntry but is a
 *  separate map because failures (rpc_failed) are never cached, so the two
 *  key sets are mutually exclusive and the cache's eviction can't clean it. */
function maybeCaptureSentry(
  key: string,
  fire: () => void,
  now: number = Date.now(),
): boolean {
  const last = lastSentryAt.get(key) ?? 0;
  if (now - last < SENTRY_MIN_INTERVAL_MS) return false;
  if (lastSentryAt.size >= CACHE_MAX_ENTRIES && !lastSentryAt.has(key)) {
    const oldest = lastSentryAt.keys().next().value;
    if (oldest !== undefined) lastSentryAt.delete(oldest);
  }
  lastSentryAt.set(key, now);
  fire();
  return true;
}

export async function GET(
  req: NextRequest,
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

  // Prefer ?network= so the caller selects which configured network's RPC to
  // use (multiple networks can share a chainId — e.g. devnet vs mainnet on
  // 42220). Fall back to the canonical mapping when omitted, so inbound URLs
  // from the previous chainId-only contract still resolve to the prod RPC.
  const networkParam = req.nextUrl.searchParams.get("network");
  let networkId: string;
  if (networkParam) {
    if (!isConfiguredNetworkId(networkParam)) {
      return NextResponse.json({ error: "Invalid network" }, { status: 400 });
    }
    if (NETWORKS[networkParam].chainId !== chainId) {
      return NextResponse.json(
        { error: "network does not match chainId" },
        { status: 400 },
      );
    }
    networkId = networkParam;
  } else {
    const fallback = networkForChainId(chainId);
    if (!fallback) {
      return NextResponse.json(
        { error: `No network configured for chain ${chainId}` },
        { status: 400 },
      );
    }
    networkId = fallback.id;
  }

  const network = NETWORKS[networkId as keyof typeof NETWORKS];
  const rpcUrl = network?.rpcUrl;
  if (!rpcUrl) {
    return NextResponse.json(
      { error: `No RPC URL configured for ${networkId}` },
      { status: 400 },
    );
  }

  // Key on networkId so devnet/local variants don't share cache entries with
  // mainnet — the same chainId+address might resolve to different bytecode
  // on different RPCs.
  const key = `${networkId}:${poolAddress.toLowerCase()}`;
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
    // Sentry captures live INSIDE the in-flight promise (not in the per-
    // request `await` block) so they fire once per upstream RPC call, not
    // once per concurrent waiter on the same key. The per-key throttle then
    // dedupes captures across successive cache cycles during a sustained
    // outage — without it, the SWR hook polling every 60s × N open tabs
    // would still flood Sentry on the second-and-beyond minutes.
    pending = resolveV2ExchangeConfig(poolAddress, rpcUrl, chainId)
      .then((result) => {
        // Only cache stable outcomes (ok:true or ok:false with a non-transient
        // reason). Transient transport failures (`rpc_failed`) propagate to
        // the awaiter below and surface as 502 — caching them would mask
        // provider outages.
        if (isCacheable(result)) {
          setCacheEntry(key, {
            result,
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
        } else if (!result.ok && result.reason === "rpc_failed") {
          maybeCaptureSentry(key, () => {
            Sentry.captureMessage("v2-exchange-config: upstream RPC failure", {
              tags: { route: "v2-exchange-config", network: networkId },
              extra: { poolAddress },
            });
          });
        }
        return result;
      })
      .catch((err) => {
        // Synchronous throw from `resolveV2ExchangeConfig` (programmer error,
        // viem internal). Redact the RPC URL — viem embeds the transport URL
        // in error messages + stacks, and a future RPC provider with path-
        // based API keys (Infura/Alchemy-style) would otherwise leak
        // credentials into Sentry/server logs. Same throttle applies.
        const redacted = redactRpcUrl(err, rpcUrl);
        maybeCaptureSentry(key, () => {
          Sentry.captureException(redacted, {
            tags: { route: "v2-exchange-config", network: networkId },
          });
        });
        console.error("[v2-exchange-config]", networkId, poolAddress, redacted);
        throw err;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, pending);
  }

  try {
    const result = await pending;
    if (!result.ok && result.reason === "rpc_failed") {
      return NextResponse.json(
        { error: "Upstream RPC error" },
        { status: 502 },
      );
    }
    return NextResponse.json(serializeResult(result));
  } catch {
    // The in-flight resolver already captured + logged this. Map to 502 here
    // and stop — re-capturing would defeat the per-key throttle.
    return NextResponse.json({ error: "Upstream RPC error" }, { status: 502 });
  }
}

function isCacheable(result: ResolveV2Result): result is CacheableResult {
  return result.ok || result.reason !== "rpc_failed";
}

function serializeResult(result: ResolveV2Result): V2ExchangeConfigResponse {
  return result.ok
    ? { ok: true, config: serializeV2ExchangeConfig(result.config) }
    : { ok: false, reason: result.reason };
}
