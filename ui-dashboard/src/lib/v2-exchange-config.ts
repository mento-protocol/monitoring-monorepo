/**
 * VirtualPool ↔ v2 BiPoolManager exchange resolver.
 *
 * VirtualPools are router-compatibility wrappers over Mento v2 exchanges:
 * `swap()` calls `Broker.swapIn(...)` and `getReserves()` reads from
 * `BiPoolManager.getPoolExchange(...)`. The exchangeId + BiPoolManager
 * address are immutable values embedded in the VP's bytecode at deployment.
 *
 * We extract them by pattern-matching the compiler-emitted PUSH32 sequence
 * in the swap() preamble:
 *
 *   7f<32-byte mgr_addr> 81 16 6004 83 0152 7f <32-byte exchangeId>
 *
 * Confirmed against all 12 VirtualPools deployed on Celo mainnet — the
 * pattern lands once per contract and yields the exchangeProvider +
 * exchangeId without an additional factory call.
 */
import { ContractFunctionRevertedError, BaseError, type Hex } from "viem";
import { BiPoolManager } from "@mento-protocol/contracts/BiPoolManager";
import { contractEntries } from "@mento-protocol/monitoring-config/tokens";
import { getViemClient } from "./rpc-client";

export type V2ExchangeConfig = {
  exchangeId: `0x${string}`;
  /** BiPoolManager address backing this VP. */
  exchangeProvider: `0x${string}`;
  asset0: `0x${string}`;
  asset1: `0x${string}`;
  pricingModule: `0x${string}`;
  /** Friendly name for the pricing module, or null when the address isn't
   *  in our hardcoded map. The UI renders the null case as an em-dash —
   *  keeping that as a presentation concern, not data. */
  pricingModuleName: string | null;
  /** FixidityLib value (1e24 unit). Divide by 1e24 for the swap fee
   *  fraction (e.g. 5e21 = 0.005 = 50 bps). */
  spread: bigint;
  referenceRateFeedID: `0x${string}`;
  /** Seconds between bucket resets from the oracle. */
  referenceRateResetFrequency: bigint;
  minimumReports: bigint;
  stablePoolResetSize: bigint;
  bucket0: bigint;
  bucket1: bigint;
  /** Unix seconds of the last bucket reset. */
  lastBucketUpdate: bigint;
  /** True when the underlying v2 exchange has been deprecated (removed
   *  from BiPoolManager). The VirtualPool contract is still deployed but
   *  routes nothing — `getPoolExchange` returns the zero struct. */
  isDeprecated: boolean;
};

export type ResolveV2Result =
  | { ok: true; config: V2ExchangeConfig }
  | {
      ok: false;
      reason: "no_bytecode" | "not_a_virtual_pool" | "rpc_failed";
    };

// Map a deployed pricing-module address to a display label per chain.
// Source of truth is `@mento-protocol/contracts/contracts.json` (via
// `contractEntries`) so adding a new chain or new module rolls in
// automatically — we don't need to maintain a hand-edited list. Mainnet's
// ConstantSum at `0xdebed1f6...` and Sepolia's at `0x3b199d9e...` both
// resolve here.
const PRICING_MODULE_LABEL: Record<string, string> = {
  ConstantSumPricingModule: "ConstantSum",
};

const PRICING_MODULE_INDEX = new Map<string, string>();
function lookupPricingModuleName(
  chainId: number,
  address: string,
): string | null {
  const key = `${chainId}:${address.toLowerCase()}`;
  if (PRICING_MODULE_INDEX.has(key)) {
    return PRICING_MODULE_INDEX.get(key) ?? null;
  }
  for (const entry of contractEntries(chainId)) {
    if (entry.type !== "contract") continue;
    const label = PRICING_MODULE_LABEL[entry.rawName];
    if (!label) continue;
    PRICING_MODULE_INDEX.set(
      `${chainId}:${entry.address.toLowerCase()}`,
      label,
    );
  }
  return PRICING_MODULE_INDEX.get(key) ?? null;
}

/**
 * Resolve a VirtualPool address to its underlying v2 exchange.
 *
 * Pure: no caching. Caller decides TTL (the `/api/v2-exchange-config` route
 * caches at the HTTP layer).
 */
/** Per-call RPC deadline. Forno's median latency is sub-second; 15s leaves
 *  plenty of headroom while bounding worst-case hang time. Without this, a
 *  provider that accepts the connection but never responds would hold an
 *  inFlight slot in the route until process restart, eventually filling the
 *  64-entry cap and 503'ing every subsequent virtual-pool page request. */
const RPC_TIMEOUT_MS = 15_000;

export async function resolveV2ExchangeConfig(
  poolAddress: string,
  rpcUrl: string,
  chainId: number,
): Promise<ResolveV2Result> {
  const client = getViemClient(rpcUrl, { timeoutMs: RPC_TIMEOUT_MS });
  let code: string | undefined;
  try {
    code = await client.getCode({
      address: poolAddress as `0x${string}`,
    });
  } catch {
    // Transport failure (timeout, network error) — match the same
    // structured `rpc_failed` mapping `readContract` uses below so the
    // route handler routes both legs through one Sentry capture path.
    // Without this, a `getCode` outage would throw out of the resolver
    // and route handlers would split observability between
    // `captureException` (for the unhandled throw) and `captureMessage`
    // (for `rpc_failed`) on identical upstream incidents.
    return { ok: false, reason: "rpc_failed" };
  }
  if (!code || code === "0x") return { ok: false, reason: "no_bytecode" };

  const extracted = extractMgrAndExchangeId(code);
  if (!extracted) return { ok: false, reason: "not_a_virtual_pool" };
  const { exchangeProvider, exchangeId } = extracted;

  let result: PoolExchangeStruct;
  try {
    result = (await client.readContract({
      address: exchangeProvider,
      abi: BiPoolManager.abi,
      functionName: "getPoolExchange",
      args: [exchangeId],
    })) as PoolExchangeStruct;
  } catch (err) {
    // BiPoolManager reverts with "An exchange with the specified id does not
    // exist" once an exchange has been removed by governance. The
    // VirtualPool wrapper stays deployed but routes nothing — surface as
    // deprecated rather than a transport error.
    if (isExchangeNotFoundRevert(err)) {
      return {
        ok: true,
        config: deprecatedConfig(exchangeProvider, exchangeId),
      };
    }
    return { ok: false, reason: "rpc_failed" };
  }

  // All-zero struct (no revert) — older BiPoolManager versions returned
  // the zero struct instead of reverting. Treat the same.
  const isDeprecated =
    result.bucket0 === BigInt(0) &&
    result.bucket1 === BigInt(0) &&
    result.lastBucketUpdate === BigInt(0) &&
    result.pricingModule === ZERO_ADDRESS;

  return {
    ok: true,
    config: {
      exchangeId,
      exchangeProvider,
      asset0: result.asset0,
      asset1: result.asset1,
      pricingModule: result.pricingModule,
      pricingModuleName: lookupPricingModuleName(chainId, result.pricingModule),
      spread: result.config.spread.value,
      referenceRateFeedID: result.config.referenceRateFeedID,
      referenceRateResetFrequency: result.config.referenceRateResetFrequency,
      minimumReports: result.config.minimumReports,
      stablePoolResetSize: result.config.stablePoolResetSize,
      bucket0: result.bucket0,
      bucket1: result.bucket1,
      lastBucketUpdate: result.lastBucketUpdate,
      isDeprecated,
    },
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Compiler-emitted opcode sequence between the two PUSH32 constants:
// 81 (DUP2) 16 (AND) 6004 (PUSH1 0x04) 83 (DUP4) 01 (ADD) 52 (MSTORE) 7f (PUSH32).
const VP_BYTECODE_PATTERN = /7f([0-9a-f]{64})811660048301527f([0-9a-f]{64})/;

function extractMgrAndExchangeId(code: string): {
  exchangeProvider: `0x${string}`;
  exchangeId: `0x${string}`;
} | null {
  const match = code.toLowerCase().match(VP_BYTECODE_PATTERN);
  if (!match) return null;
  // First match is the address, right-aligned in 32 bytes — bottom 20
  // bytes is the actual address.
  const mgrPadded = match[1];
  const exchangeProvider = ("0x" + mgrPadded.slice(24)) as `0x${string}`;
  const exchangeId = ("0x" + match[2]) as `0x${string}`;
  return { exchangeProvider, exchangeId };
}

// Shape of the decoded PoolExchange struct. Mirrors the ABI from
// `@mento-protocol/contracts/BiPoolManager` so the cast above is type-safe.
type PoolExchangeStruct = {
  asset0: `0x${string}`;
  asset1: `0x${string}`;
  pricingModule: `0x${string}`;
  bucket0: bigint;
  bucket1: bigint;
  lastBucketUpdate: bigint;
  config: {
    spread: { value: bigint };
    referenceRateFeedID: `0x${string}`;
    referenceRateResetFrequency: bigint;
    minimumReports: bigint;
    stablePoolResetSize: bigint;
  };
};

function isExchangeNotFoundRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const reverted = err.walk(
    (e) => e instanceof ContractFunctionRevertedError,
  ) as ContractFunctionRevertedError | undefined;
  // Matches the BiPoolManager revert string:
  //   "An exchange with the specified id does not exist"
  // If the contract message ever changes, this falls through to `rpc_failed`
  // and a deprecated pool would render an upstream-error UI instead of the
  // amber deprecation callout — a unit test in v2-exchange-config.test.ts
  // exercises the exact reason string so a contract bump would surface here.
  return reverted?.reason?.includes("does not exist") ?? false;
}

// ---------------------------------------------------------------------------
// Wire DTO — shared by the API route + the SWR client hook so a field add
// can't drift between server and client. BigInts can't go through
// JSON.stringify, so we send them as decimal strings; the client converts
// back where it needs arithmetic.
// ---------------------------------------------------------------------------

export type V2ExchangeConfigDTO = {
  exchangeId: string;
  exchangeProvider: string;
  asset0: string;
  asset1: string;
  pricingModule: string;
  pricingModuleName: string | null;
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
  | { ok: true; config: V2ExchangeConfigDTO }
  | {
      ok: false;
      reason: "no_bytecode" | "not_a_virtual_pool" | "rpc_failed";
    };

export function serializeV2ExchangeConfig(
  c: V2ExchangeConfig,
): V2ExchangeConfigDTO {
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

function deprecatedConfig(
  exchangeProvider: `0x${string}`,
  exchangeId: Hex,
): V2ExchangeConfig {
  return {
    exchangeId: exchangeId as `0x${string}`,
    exchangeProvider,
    asset0: ZERO_ADDRESS as `0x${string}`,
    asset1: ZERO_ADDRESS as `0x${string}`,
    pricingModule: ZERO_ADDRESS as `0x${string}`,
    pricingModuleName: null,
    spread: BigInt(0),
    referenceRateFeedID: ZERO_ADDRESS as `0x${string}`,
    referenceRateResetFrequency: BigInt(0),
    minimumReports: BigInt(0),
    stablePoolResetSize: BigInt(0),
    bucket0: BigInt(0),
    bucket1: BigInt(0),
    lastBucketUpdate: BigInt(0),
    isDeprecated: true,
  };
}
