import {
  FPMMFactory,
  FPMM,
  Pool,
  PoolSnapshot,
  OracleSnapshot,
  FactoryDeployment,
  LiquidityEvent,
  RebalanceEvent,
  ReserveUpdate,
  SwapEvent,
  TradingLimit,
  VirtualPoolFactory,
  VirtualPool,
  VirtualPoolLifecycle,
  SortedOracles,
} from "generated";
import type { HandlerContext } from "generated/src/Types";

import { createPublicClient, http } from "viem";

// ABI is the only thing needed directly from the package here — address
// resolution is delegated to contractAddresses.ts (shared with tests).
import _sortedOraclesAbi from "@mento-protocol/contracts/abis/SortedOracles.json";
import {
  requireContractAddress,
  CONTRACT_NAMESPACE_BY_CHAIN,
} from "./contractAddresses";

// Addresses are resolved lazily per active chainId rather than eagerly for all
// chains at module init. This avoids crashing the indexer on startup if a future
// package update removes or renames a Sepolia namespace entry while mainnet is
// still valid — only chains that are actually indexed will fail.
const SortedOraclesContract = {
  /** Returns the SortedOracles address for the given chainId, throwing if missing. */
  address: (chainId: number): `0x${string}` =>
    requireContractAddress(chainId, "SortedOracles"),
  abi: _sortedOraclesAbi,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const eventId = (
  chainId: number,
  blockNumber: number,
  logIndex: number,
): string => `${chainId}_${blockNumber}_${logIndex}`;

const asAddress = (value: string): string => value.toLowerCase();
const asBigInt = (value: number): bigint => BigInt(value);

const SECONDS_PER_HOUR = 3600n;

/** Round a unix timestamp down to the start of its hour. */
const hourBucket = (timestamp: bigint): bigint =>
  (timestamp / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;

/** Deterministic snapshot ID: "{poolId}-{hourTimestamp}" */
const snapshotId = (poolId: string, hourTs: bigint): string =>
  `${poolId}-${hourTs}`;

// ---------------------------------------------------------------------------
// Oracle helpers
// ---------------------------------------------------------------------------

/** In-memory mapping: rateFeedID (lowercase) → Set of poolIds that use it.
 * Multiple FPMM pools can share the same SortedOracles rate feed.
 *
 * ⚠️ This map is populated at FPMMDeployed handler time. It is in-memory only
 * and is rebuilt during historical re-sync. Any OracleReported / MedianUpdated
 * events processed before their corresponding FPMMDeployed event (which can't
 * happen in correct block order, but worth noting for debugging) would miss all
 * pools. If the indexer restarts mid-sync, the map is empty for already-synced
 * blocks — Envio re-processes all events from the start, so this is fine in
 * practice, but the map should not be treated as a persistent data structure. */
// rateFeedPoolMap was removed — SortedOracles handlers now use
// context.Pool.getWhere.referenceRateFeedID.eq() (DB-backed, works across
// Envio worker processes; in-memory maps are not shared between workers).

/** oraclePrice is stored in **feed direction** (SortedOracles "feedToken/USD")
 * at 24dp precision. Divide by 10^SORTED_ORACLES_DECIMALS to get the
 * human-readable price (e.g. "1 GBP = 1.34 USD").
 *
 * OracleReported/MedianUpdated handlers now call getRebalancingState() for
 * block-final consistency: both oraclePrice and priceDifference are derived
 * from the same RPC call (18dp numerator/denominator × ORACLE_ADAPTER_SCALE_FACTOR
 * to restore 24dp). Falls back to event.params.value + local computePriceDifference()
 * only when getRebalancingState() fails (e.g. stale oracle, error 0xa407143a).
 * UpdateReserves/Rebalanced handlers use the same pattern. */
const SORTED_ORACLES_DECIMALS = 24;

/** OracleAdapter divides both numerator and denominator by 1e6, converting
 * SortedOracles' 24dp precision to 18dp. Multiply by this factor to restore
 * the original 24dp scale when reading from getRebalancingState(). */
const ORACLE_ADAPTER_SCALE_FACTOR = 1_000_000n;

// Lazy RPC clients per chainId
const rpcClients = new Map<number, ReturnType<typeof createPublicClient>>();

// ---------------------------------------------------------------------------
// Test hooks — only used in unit tests to inject mock RPC responses.
// Never set in production; `fetchRebalancingState` checks this map first.
// ---------------------------------------------------------------------------
const _testRebalancingStates = new Map<string, RebalancingState | null>();

/** @internal Test-only: pre-set a mock rebalancing state for a pool. */
export function _setMockRebalancingState(
  chainId: number,
  poolAddress: string,
  state: RebalancingState | null,
): void {
  const key = `${chainId}:${poolAddress.toLowerCase()}`;
  if (state === null) {
    _testRebalancingStates.delete(key);
  } else {
    _testRebalancingStates.set(key, state);
  }
}

/** @internal Test-only: clear all mock rebalancing states. */
export function _clearMockRebalancingStates(): void {
  _testRebalancingStates.clear();
}

// Per-chain RPC defaults. ENVIO_RPC_URL overrides the default for the active chain.
// Every indexed chain MUST have an entry here — missing chains fall through to the
// Celo Sepolia default and silently produce wrong oracle/trading-limit/decimals data.
const DEFAULT_RPC_BY_CHAIN: Record<number, string> = {
  42220: "https://forno.celo.org", // Celo Mainnet
  11142220: "https://forno.celo-sepolia.celo-testnet.org", // Celo Sepolia
  143: "https://rpc2.monad.xyz", // Monad Mainnet (Goldsky Edge — supports historical eth_call)
  10143: "https://10143.rpc.hypersync.xyz", // Monad Testnet (Envio HyperRPC)
};

function getRpcClient(chainId: number): ReturnType<typeof createPublicClient> {
  if (!rpcClients.has(chainId)) {
    const defaultRpc = DEFAULT_RPC_BY_CHAIN[chainId];
    if (!defaultRpc) {
      throw new Error(
        `[getRpcClient] No default RPC configured for chainId ${chainId}. ` +
          `Add an entry to DEFAULT_RPC_BY_CHAIN in EventHandlers.ts.`,
      );
    }
    rpcClients.set(
      chainId,
      createPublicClient({
        transport: http(process.env.ENVIO_RPC_URL ?? defaultRpc, {
          batch: true,
        }),
      }),
    );
  }
  return rpcClients.get(chainId)!;
}

/** Returns SortedOracles address for chainId, throws if not in @mento-protocol/contracts. */
const SORTED_ORACLES_ADDRESS = SortedOraclesContract.address;

/** Cache numRates by block — numRates can't change within a single block, so
 * this is always precise (no stale risk in live mode) while still collapsing
 * redundant RPC calls during historical sync where many events share a block.
 * Key: "chainId:feedId:blockNumber" */
const numReportersCache = new Map<string, number>();

/** Cache report expiry per feed.
 * Key: "chainId:feedId:blockNumber" — same pattern as numReportersCache.
 * Including blockNumber ensures historical backfills that span a governance change
 * (e.g. tokenReportExpirySeconds updated on-chain) pick up the correct value at
 * each block rather than reusing the first-seen expiry forever. */
const reportExpiryCache = new Map<string, bigint>();

/** Returns all FPMM pool IDs that reference the given rateFeedID.
 * Uses context.Pool.getWhere (DB-backed) so it works correctly in Envio's
 * multi-process hosted environment where in-memory maps are not shared. */
async function getPoolsByFeed(
  context: HandlerContext,
  rateFeedID: string,
): Promise<string[]> {
  const pools = await context.Pool.getWhere.referenceRateFeedID.eq(rateFeedID);
  return pools.map((p) => p.id);
}

/** Returns the number of active oracle reporters for the given rateFeedID at
 * the given block, or null on error. Callers can preserve the last known-good
 * value instead of persisting a fabricated zero on transient RPC failures.
 * Results are cached per block so each block pays at most one RPC call per
 * feed regardless of how many pools share it. */
async function fetchNumReporters(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<number | null> {
  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    // Chain not in CONTRACT_NAMESPACE_BY_CHAIN or package entry missing.
    return null;
  }

  const cacheKey = `${chainId}:${rateFeedID}:${blockNumber}`;
  const cached = numReportersCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const count = await client.readContract({
      address,
      abi: SortedOraclesContract.abi,
      functionName: "numRates",
      args: [rateFeedID as `0x${string}`],
      blockNumber,
    });
    const value = Number(count);
    numReportersCache.set(cacheKey, value);
    return value;
  } catch {
    return null;
  }
}

/** Returns the effective oracle report expiry (seconds) for the given rateFeedID:
 * uses the per-token override if non-zero, otherwise falls back to the global
 * reportExpirySeconds(). Returns null on RPC/address error so callers can preserve
 * the previous known-good value instead of persisting a fabricated threshold. */
async function fetchReportExpiry(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<bigint | null> {
  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }

  const cacheKey = `${chainId}:${rateFeedID}:${blockNumber}`;
  const cached = reportExpiryCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const tokenExpiry = (await client.readContract({
      address,
      abi: SortedOraclesContract.abi,
      functionName: "tokenReportExpirySeconds",
      args: [rateFeedID as `0x${string}`],
      blockNumber,
    })) as bigint;
    const expiry: bigint =
      tokenExpiry > 0n
        ? tokenExpiry
        : ((await client.readContract({
            address,
            abi: SortedOraclesContract.abi,
            functionName: "reportExpirySeconds",
            blockNumber,
          })) as bigint);
    if (expiry <= 0n) return null;
    reportExpiryCache.set(cacheKey, expiry);
    return expiry;
  } catch {
    return null;
  }
}

async function updatePoolsOracleExpiry(
  context: HandlerContext,
  poolIds: string[],
  oracleExpiry: bigint | null,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  if (oracleExpiry === null || poolIds.length === 0) return;

  for (const poolId of poolIds) {
    const existing = await context.Pool.get(poolId);
    if (!existing || existing.oracleExpiry === oracleExpiry) continue;

    const updatedPool: Pool = {
      ...existing,
      oracleExpiry,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    };
    context.Pool.set(updatedPool);
  }
}

async function getPoolsWithReferenceFeed(
  context: HandlerContext,
): Promise<Pool[]> {
  return context.Pool.getWhere.referenceRateFeedID.gt("");
}

/** TradingLimitsV2 stores all limit/netflow values in 15-decimal internal precision. */
export const TRADING_LIMITS_INTERNAL_DECIMALS = 15;

const FPMM_TRADING_LIMITS_ABI = [
  {
    type: "function",
    name: "getTradingLimits",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "limit0", type: "int120" },
          { name: "limit1", type: "int120" },
          { name: "decimals", type: "uint8" },
        ],
      },
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "lastUpdated0", type: "uint32" },
          { name: "lastUpdated1", type: "uint32" },
          { name: "netflow0", type: "int96" },
          { name: "netflow1", type: "int96" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

const FPMM_MINIMAL_ABI = [
  {
    type: "function",
    name: "decimals0",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals1",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rebalanceThresholdAbove",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rebalanceThresholdBelow",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRebalancingState",
    inputs: [],
    outputs: [
      { name: "oraclePriceNumerator", type: "uint256" },
      { name: "oraclePriceDenominator", type: "uint256" },
      { name: "reservePriceNumerator", type: "uint256" },
      { name: "reservePriceDenominator", type: "uint256" },
      { name: "reservePriceAboveOraclePrice", type: "bool" },
      { name: "rebalanceThreshold", type: "uint16" },
      { name: "priceDifference", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "referenceRateFeedID",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "invertRateFeed",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

type RebalancingState = {
  oraclePriceNumerator: bigint;
  oraclePriceDenominator: bigint;
  rebalanceThreshold: number;
  priceDifference: bigint;
};

async function fetchRebalancingState(
  chainId: number,
  poolAddress: string,
  blockNumber?: bigint,
): Promise<RebalancingState | null> {
  // In unit tests, callers inject a mock via _setMockRebalancingState so no RPC is needed.
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRebalancingStates.has(testKey)) {
    return _testRebalancingStates.get(testKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "getRebalancingState",
      ...(blockNumber !== undefined && { blockNumber }),
    });
    // viem returns a tuple: [num, denom, rNum, rDenom, above, threshold, diff]
    const r = result as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
      number,
      bigint,
    ];
    return {
      oraclePriceNumerator: r[0],
      oraclePriceDenominator: r[1],
      rebalanceThreshold: Number(r[5]),
      priceDifference: r[6],
    };
  } catch {
    return null;
  }
}

/** Fetch the pool's invertRateFeed flag. Returns false on error (default). */
async function fetchInvertRateFeed(
  chainId: number,
  poolAddress: string,
): Promise<boolean> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "invertRateFeed",
    });
    return result as boolean;
  } catch {
    return false;
  }
}

/** Fetch the pool's rebalance threshold using standalone getters that do NOT
 * require the oracle to be live (unlike getRebalancingState which reverts when
 * the oracle is stale). Returns the max of thresholdAbove/thresholdBelow, or 0. */
async function fetchRebalanceThreshold(
  chainId: number,
  poolAddress: string,
): Promise<number> {
  try {
    const client = getRpcClient(chainId);
    const [above, below] = await Promise.all([
      client.readContract({
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "rebalanceThresholdAbove",
      }),
      client.readContract({
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "rebalanceThresholdBelow",
      }),
    ]);
    return Math.max(Number(above), Number(below));
  } catch {
    return 0;
  }
}

async function fetchReferenceRateFeedID(
  chainId: number,
  poolAddress: string,
): Promise<string | null> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "referenceRateFeedID",
    });
    return (result as string).toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trading limit helpers
// ---------------------------------------------------------------------------

type TradingLimitData = {
  config: { limit0: bigint; limit1: bigint; decimals: number };
  state: {
    lastUpdated0: number;
    lastUpdated1: number;
    netflow0: bigint;
    netflow1: bigint;
  };
};

/** Fetches decimals0() or decimals1() from an FPMM pool — returns the scaling
 *  factor (e.g. 1000000000000000000n for 18dp, 1000000n for 6dp). */
async function fetchTokenDecimalsScaling(
  chainId: number,
  poolAddress: string,
  fn: "decimals0" | "decimals1",
): Promise<bigint | null> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: fn,
    });
    return result as bigint;
  } catch {
    return null;
  }
}

async function fetchTradingLimits(
  chainId: number,
  poolAddress: string,
  token: string,
): Promise<TradingLimitData | null> {
  try {
    const client = getRpcClient(chainId);
    const result = (await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_TRADING_LIMITS_ABI,
      functionName: "getTradingLimits",
      args: [token as `0x${string}`],
    })) as unknown as [
      { limit0: bigint; limit1: bigint; decimals: number },
      {
        lastUpdated0: number;
        lastUpdated1: number;
        netflow0: bigint;
        netflow1: bigint;
      },
    ];
    const [config, state] = result;
    return { config, state };
  } catch {
    return null;
  }
}

function computeLimitStatus(p0: number, p1: number): string {
  const worst = Math.max(p0, p1);
  if (worst >= 1.0) return "CRITICAL";
  if (worst > 0.8) return "WARN";
  return "OK";
}

function computeLimitPressures(
  netflow0: bigint,
  netflow1: bigint,
  limit0: bigint,
  limit1: bigint,
): { p0: number; p1: number } {
  const abs0 = netflow0 < 0n ? -netflow0 : netflow0;
  const abs1 = netflow1 < 0n ? -netflow1 : netflow1;
  const p0 = limit0 !== 0n ? Number(abs0) / Number(limit0) : 0;
  const p1 = limit1 !== 0n ? Number(abs1) / Number(limit1) : 0;
  return { p0, p1 };
}

// ---------------------------------------------------------------------------
// Price difference computation (reserve ratio vs oracle price)
// ---------------------------------------------------------------------------

/**
 * Computes priceDifference in basis points (bps) from reserves and oracle price,
 * matching the on-chain FPMM formula: |reservePrice - oraclePrice| / oraclePrice.
 *
 * The on-chain contract always computes in one direction:
 *   reservePrice = (reserve0 * tpm0) / (reserve1 * tpm1)
 *   oraclePrice  = oraclePriceNumerator / oraclePriceDenominator
 *   priceDifference = |reservePrice - oraclePrice| * 10000 / oraclePrice
 *
 * Oracle price is stored in **feed direction** (24dp SortedOracles rate):
 *   e.g. GBP/USD = 1.339150e24 means "1 GBP = 1.339150 USD"
 *
 * When USDm is token0: reserveRatio = USDm/nonUSD = feedPrice → compare directly.
 * When USDm is token1: reserveRatio = nonUSD/USDm = 1/feedPrice → invert
 *   reserveRatio to get USDm/nonUSD, then compare against feedPrice directly.
 *
 * IMPORTANT: The deviation formula |R - O| / O is NOT invariant under inversion
 * of both R and O: |1/R - 1/O| / (1/O) = |R - O| / R (divides by R, not O!).
 * So we must always compute in the feed direction to match the contract.
 *
 * Returns 0n when oracle price or reserves are missing/zero.
 */
/**
 * Normalize an amount to 18 decimal precision regardless of source token decimals.
 * Handles dec < 18 (scale up), dec > 18 (scale down), dec === 18 (no-op).
 */
export function normalizeTo18(amount: bigint, decimals: number): bigint {
  if (decimals === 18) return amount;
  if (decimals < 18) return amount * 10n ** BigInt(18 - decimals);
  return amount / 10n ** BigInt(decimals - 18);
}

/**
 * Convert an on-chain ERC20 decimals scaling factor (e.g. 1000000n for 6dp,
 * 10^18 for 18dp) to a plain decimals count. Returns null if the value is not
 * a valid power of 10 (rejects unexpected/corrupt on-chain values).
 */
export function scalingFactorToDecimals(scaling: bigint): number | null {
  if (scaling <= 0n) return null;
  let d = 0;
  let n = scaling;
  while (n > 1n && n % 10n === 0n) {
    n /= 10n;
    d += 1;
  }
  return n === 1n ? d : null; // reject non-10^n values
}

export function computePriceDifference(pool: {
  reserves0: bigint;
  reserves1: bigint;
  oraclePrice: bigint;
  invertRateFeed: boolean;
  token0Decimals: number;
  token1Decimals: number;
}): bigint {
  if (pool.oraclePrice === 0n || pool.reserves0 === 0n || pool.reserves1 === 0n)
    return 0n;

  const SCALE = 10n ** 24n;
  // Normalize reserves to 18 decimals before computing ratio.
  const norm0 = normalizeTo18(pool.reserves0, pool.token0Decimals);
  const norm1 = normalizeTo18(pool.reserves1, pool.token1Decimals);
  // Guard against normalization flooring to zero (possible when decimals > 18).
  if (norm0 === 0n || norm1 === 0n) return 0n;

  // Always compute reserve0/reserve1 — matches the contract's reservePrice.
  const reserveRatio = (norm0 * SCALE) / norm1;

  // oraclePrice is stored in feed direction (raw SortedOracles rate at 24dp).
  // When invertRateFeed is true, the contract compares reserves against 1/feedRate.
  const oracleRef = pool.invertRateFeed
    ? (SCALE * SCALE) / pool.oraclePrice
    : pool.oraclePrice;

  // priceDiff in bps: |reserveRatio - oracleRef| * 10000 / oracleRef
  const diff =
    reserveRatio > oracleRef
      ? reserveRatio - oracleRef
      : oracleRef - reserveRatio;
  return (diff * 10000n) / oracleRef;
}

// ---------------------------------------------------------------------------
// Health status computation
// ---------------------------------------------------------------------------

function computeHealthStatus(pool: Pool): string {
  if (pool.source?.includes("virtual")) return "N/A";
  if (!pool.oracleOk) return "CRITICAL";
  const threshold =
    pool.rebalanceThreshold > 0 ? pool.rebalanceThreshold : 10000;
  const devRatio = Number(pool.priceDifference) / threshold;
  if (devRatio >= 1.0) return "CRITICAL";
  if (devRatio >= 0.8) return "WARN";
  return "OK";
}

// ---------------------------------------------------------------------------
// Pool upsert (with cumulative fields)
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY: Record<string, number> = {
  virtual_pool_factory: 100,
  fpmm_factory: 90,
  fpmm_rebalanced: 50,
  fpmm_update_reserves: 40,
  fpmm_swap: 30,
  fpmm_mint: 20,
  fpmm_burn: 20,
};

const pickPreferredSource = (
  existingSource: string | undefined,
  incomingSource: string,
): string => {
  if (!existingSource) return incomingSource;
  const existingPriority = SOURCE_PRIORITY[existingSource] ?? 0;
  const incomingPriority = SOURCE_PRIORITY[incomingSource] ?? 0;
  return incomingPriority >= existingPriority ? incomingSource : existingSource;
};

type PoolContext = {
  Pool: {
    get: (id: string) => Promise<Pool | undefined>;
    set: (entity: Pool) => void;
  };
};

type SnapshotContext = {
  PoolSnapshot: {
    get: (id: string) => Promise<PoolSnapshot | undefined>;
    set: (entity: PoolSnapshot) => void;
  };
};

/** Default oracle field values (for VirtualPools or when RPC call fails) */
const DEFAULT_ORACLE_FIELDS = {
  oracleOk: false,
  oraclePrice: 0n,
  oracleTimestamp: 0n,
  oracleTxHash: "",
  oracleExpiry: 0n,
  oracleNumReporters: 0,
  referenceRateFeedID: "",
  invertRateFeed: false,
  priceDifference: 0n,
  rebalanceThreshold: 0,
  lastRebalancedAt: 0n,
  healthStatus: "N/A" as string,
  limitStatus: "N/A" as string,
  limitPressure0: "0.0000" as string,
  limitPressure1: "0.0000" as string,
  rebalancerAddress: "" as string,
  rebalanceLivenessStatus: "N/A" as string,
  token0Decimals: 18,
  token1Decimals: 18,
};

const getOrCreatePool = async (
  context: PoolContext,
  poolId: string,
  defaults?: { token0?: string; token1?: string },
): Promise<Pool> => {
  const existing = await context.Pool.get(poolId);
  if (existing) return existing;
  return {
    id: poolId,
    token0: defaults?.token0,
    token1: defaults?.token1,
    source: "",
    reserves0: 0n,
    reserves1: 0n,
    swapCount: 0,
    notionalVolume0: 0n,
    notionalVolume1: 0n,
    rebalanceCount: 0,
    ...DEFAULT_ORACLE_FIELDS,
    createdAtBlock: 0n,
    createdAtTimestamp: 0n,
    updatedAtBlock: 0n,
    updatedAtTimestamp: 0n,
  };
};

const upsertPool = async ({
  context,
  poolId,
  token0,
  token1,
  source,
  blockNumber,
  blockTimestamp,
  reservesDelta,
  swapDelta,
  rebalanceDelta,
  oracleDelta,
  tokenDecimals,
}: {
  context: PoolContext;
  poolId: string;
  token0?: string;
  token1?: string;
  source: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  reservesDelta?: { reserve0: bigint; reserve1: bigint };
  swapDelta?: { volume0: bigint; volume1: bigint };
  rebalanceDelta?: boolean;
  oracleDelta?: Partial<typeof DEFAULT_ORACLE_FIELDS>;
  tokenDecimals?: { token0Decimals: number; token1Decimals: number };
}): Promise<Pool> => {
  const existing = await getOrCreatePool(context, poolId, { token0, token1 });

  let next: Pool = {
    ...existing,
    token0: token0 ?? existing.token0,
    token1: token1 ?? existing.token1,
    source: pickPreferredSource(existing.source, source),
    reserves0: reservesDelta?.reserve0 ?? existing.reserves0,
    reserves1: reservesDelta?.reserve1 ?? existing.reserves1,
    swapCount: existing.swapCount + (swapDelta ? 1 : 0),
    notionalVolume0: existing.notionalVolume0 + (swapDelta?.volume0 ?? 0n),
    notionalVolume1: existing.notionalVolume1 + (swapDelta?.volume1 ?? 0n),
    rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
    // Merge oracle delta if provided
    ...(oracleDelta ?? {}),
    // Persist token decimals if provided (set once at pool creation)
    token0Decimals: tokenDecimals?.token0Decimals ?? existing.token0Decimals,
    token1Decimals: tokenDecimals?.token1Decimals ?? existing.token1Decimals,
    createdAtBlock:
      existing.createdAtBlock === 0n ? blockNumber : existing.createdAtBlock,
    createdAtTimestamp:
      existing.createdAtTimestamp === 0n
        ? blockTimestamp
        : existing.createdAtTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };

  // Use contract-provided priceDifference when available (passed via oracleDelta
  // from fetchRebalancingState). Only fall back to local recomputation when the
  // contract value was not supplied (e.g. oracle-only update events).
  const hasContractPriceDiff =
    oracleDelta != null &&
    "priceDifference" in oracleDelta &&
    oracleDelta.priceDifference !== undefined;
  const priceDifference = hasContractPriceDiff
    ? oracleDelta.priceDifference!
    : !next.source?.includes("virtual") && next.oraclePrice > 0n
      ? computePriceDifference(next)
      : next.priceDifference;

  const withDeviation = { ...next, priceDifference };
  const healthStatus = computeHealthStatus(withDeviation);
  const final = { ...withDeviation, healthStatus };

  context.Pool.set(final);
  return final;
};

// ---------------------------------------------------------------------------
// PoolSnapshot upsert
// ---------------------------------------------------------------------------

const upsertSnapshot = async ({
  context,
  pool,
  blockTimestamp,
  blockNumber,
  swapDelta,
  rebalanceDelta,
  mintDelta,
  burnDelta,
}: {
  context: SnapshotContext;
  pool: Pool;
  blockTimestamp: bigint;
  blockNumber: bigint;
  swapDelta?: { volume0: bigint; volume1: bigint };
  rebalanceDelta?: boolean;
  mintDelta?: boolean;
  burnDelta?: boolean;
}): Promise<void> => {
  const hourTs = hourBucket(blockTimestamp);
  const id = snapshotId(pool.id, hourTs);
  const existing = await context.PoolSnapshot.get(id);

  const snapshot: PoolSnapshot = existing
    ? {
        ...existing,
        // Update point-in-time state to latest
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        // Increment per-hour counters
        swapCount: existing.swapCount + (swapDelta ? 1 : 0),
        swapVolume0: existing.swapVolume0 + (swapDelta?.volume0 ?? 0n),
        swapVolume1: existing.swapVolume1 + (swapDelta?.volume1 ?? 0n),
        rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
        mintCount: existing.mintCount + (mintDelta ? 1 : 0),
        burnCount: existing.burnCount + (burnDelta ? 1 : 0),
        // Snapshot of pool running totals
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        blockNumber,
      }
    : {
        id,
        poolId: pool.id,
        timestamp: hourTs,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: swapDelta ? 1 : 0,
        swapVolume0: swapDelta?.volume0 ?? 0n,
        swapVolume1: swapDelta?.volume1 ?? 0n,
        rebalanceCount: rebalanceDelta ? 1 : 0,
        mintCount: mintDelta ? 1 : 0,
        burnCount: burnDelta ? 1 : 0,
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        blockNumber,
      };

  context.PoolSnapshot.set(snapshot);
};

// ---------------------------------------------------------------------------
// Event Handlers — FPMM
// ---------------------------------------------------------------------------

FPMMFactory.FPMMDeployed.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.fpmmProxy);
  const token0 = asAddress(event.params.token0);
  const token1 = asAddress(event.params.token1);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch oracle state from chain at pool creation
  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};

  const [rateFeedID, rebalanceThreshold, dec0Raw, dec1Raw, invertRateFeed] =
    await Promise.all([
      fetchReferenceRateFeedID(event.chainId, poolId),
      // Use standalone getters — they work even when the oracle is stale,
      // unlike getRebalancingState() which reverts on stale/expired oracle data.
      fetchRebalanceThreshold(event.chainId, poolId),
      // Fetch token decimals scaling factors (e.g. 1e18 for 18-decimal tokens)
      fetchTokenDecimalsScaling(event.chainId, poolId, "decimals0"),
      fetchTokenDecimalsScaling(event.chainId, poolId, "decimals1"),
      fetchInvertRateFeed(event.chainId, poolId),
    ]);
  // Convert scaling factor (1e18, 1e6, etc.) to decimals count (18, 6, etc.)
  // scalingFactorToDecimals rejects non-power-of-10 values (returns null → fallback 18)
  const token0Decimals = dec0Raw
    ? (scalingFactorToDecimals(dec0Raw) ?? 18)
    : 18;
  const token1Decimals = dec1Raw
    ? (scalingFactorToDecimals(dec1Raw) ?? 18)
    : 18;

  if (rateFeedID) {
    oracleDelta.referenceRateFeedID = rateFeedID;
    // Populate oracleExpiry at creation so the dashboard uses the correct
    // staleness threshold immediately, before the first oracle event arrives.
    const oracleExpiry = await fetchReportExpiry(
      event.chainId,
      rateFeedID,
      blockNumber,
    );
    if (oracleExpiry !== null) {
      oracleDelta.oracleExpiry = oracleExpiry;
    }
  }

  oracleDelta.invertRateFeed = invertRateFeed;

  if (rebalanceThreshold > 0) {
    oracleDelta.rebalanceThreshold = rebalanceThreshold;
  }
  oracleDelta.oracleTxHash = event.transaction.hash;

  const pool = await upsertPool({
    context,
    poolId,
    token0,
    token1,
    source: "fpmm_factory",
    blockNumber,
    blockTimestamp,
    oracleDelta,
    tokenDecimals: { token0Decimals, token1Decimals },
  });

  const deployment: FactoryDeployment = {
    id,
    poolId,
    token0,
    token1,
    implementation: asAddress(event.params.fpmmImplementation),
    factoryAddress: asAddress(event.srcAddress),
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.FactoryDeployment.set(deployment);
});

FPMM.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Compute volume: max of in/out for each token side
  const volume0 =
    event.params.amount0In > event.params.amount0Out
      ? event.params.amount0In
      : event.params.amount0Out;
  const volume1 =
    event.params.amount1In > event.params.amount1Out
      ? event.params.amount1In
      : event.params.amount1Out;

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_swap",
    blockNumber,
    blockTimestamp,
    swapDelta: { volume0, volume1 },
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    swapDelta: { volume0, volume1 },
  });

  // Update trading limits for FPMM pools (guard: getTradingLimits reverts on VirtualPools)
  if (
    pool.source &&
    pool.source.includes("fpmm") &&
    pool.token0 &&
    pool.token1
  ) {
    const [limits0, limits1] = await Promise.all([
      fetchTradingLimits(event.chainId, event.srcAddress, pool.token0),
      fetchTradingLimits(event.chainId, event.srcAddress, pool.token1),
    ]);

    let worstP0 = 0;
    let worstP1 = 0;

    if (limits0) {
      const { p0, p1 } = computeLimitPressures(
        limits0.state.netflow0,
        limits0.state.netflow1,
        limits0.config.limit0,
        limits0.config.limit1,
      );
      worstP0 = Math.max(worstP0, p0, p1);
      const tl: TradingLimit = {
        id: `${poolId}-${pool.token0}`,
        poolId,
        token: pool.token0,
        limit0: limits0.config.limit0,
        limit1: limits0.config.limit1,
        decimals: TRADING_LIMITS_INTERNAL_DECIMALS,
        netflow0: limits0.state.netflow0,
        netflow1: limits0.state.netflow1,
        lastUpdated0: BigInt(limits0.state.lastUpdated0),
        lastUpdated1: BigInt(limits0.state.lastUpdated1),
        limitPressure0: p0.toFixed(4),
        limitPressure1: p1.toFixed(4),
        limitStatus: computeLimitStatus(p0, p1),
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      context.TradingLimit.set(tl);
    }

    if (limits1) {
      const { p0, p1 } = computeLimitPressures(
        limits1.state.netflow0,
        limits1.state.netflow1,
        limits1.config.limit0,
        limits1.config.limit1,
      );
      worstP1 = Math.max(worstP1, p0, p1);
      const tl: TradingLimit = {
        id: `${poolId}-${pool.token1}`,
        poolId,
        token: pool.token1,
        limit0: limits1.config.limit0,
        limit1: limits1.config.limit1,
        decimals: TRADING_LIMITS_INTERNAL_DECIMALS,
        netflow0: limits1.state.netflow0,
        netflow1: limits1.state.netflow1,
        lastUpdated0: BigInt(limits1.state.lastUpdated0),
        lastUpdated1: BigInt(limits1.state.lastUpdated1),
        limitPressure0: p0.toFixed(4),
        limitPressure1: p1.toFixed(4),
        limitStatus: computeLimitStatus(p0, p1),
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      context.TradingLimit.set(tl);
    }

    if (limits0 || limits1) {
      const overallWorst = Math.max(worstP0, worstP1);
      const limitStatus = computeLimitStatus(overallWorst, 0);
      const updatedPool = await context.Pool.get(poolId);
      if (updatedPool) {
        context.Pool.set({
          ...updatedPool,
          limitStatus,
          limitPressure0: worstP0.toFixed(4),
          limitPressure1: worstP1.toFixed(4),
        });
      }
    }
  }

  const swap: SwapEvent = {
    id,
    poolId,
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0In: event.params.amount0In,
    amount1In: event.params.amount1In,
    amount0Out: event.params.amount0Out,
    amount1Out: event.params.amount1Out,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.SwapEvent.set(swap);
});

FPMM.Mint.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_mint",
    blockNumber,
    blockTimestamp,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    mintDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    poolId,
    kind: "MINT",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

FPMM.Burn.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_burn",
    blockNumber,
    blockTimestamp,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    burnDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    poolId,
    kind: "BURN",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

FPMM.UpdateReserves.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch fresh rebalancing state for FPMM pools (pinned to event block).
  // Note: eth_call is block-final, not tx-final. Multiple events in the same block
  // may all record the same post-block priceDifference — an accepted approximation
  // for monitoring purposes.
  const rebalancingState = await fetchRebalancingState(
    event.chainId,
    poolId,
    blockNumber,
  );

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};
  if (rebalancingState) {
    // Read existing pool to check invertRateFeed flag.
    // For inverted pools, getRebalancingState returns numerator=1e18 and
    // denominator=feedRate_18dp. We always store oracle price in feed direction
    // (raw SortedOracles rate at 24dp) for consistency with OracleReported events.
    const existing = await context.Pool.get(poolId);
    const isInverted = existing?.invertRateFeed ?? false;
    const oraclePrice = isInverted
      ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR;

    oracleDelta = {
      oraclePrice,
      rebalanceThreshold: rebalancingState.rebalanceThreshold,
      priceDifference: rebalancingState.priceDifference,
      oracleTimestamp: blockTimestamp,
    };
  }

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_update_reserves",
    blockNumber,
    blockTimestamp,
    reservesDelta: {
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    },
    oracleDelta,
  });

  // Create OracleSnapshot if we got data from rebalancingState RPC
  if (rebalancingState) {
    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: oracleDelta.oraclePrice!,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      rebalanceThreshold: pool.rebalanceThreshold,
      source: "update_reserves",
      blockNumber,
    };
    context.OracleSnapshot.set(snapshot);
  }

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
  });

  const reserveUpdate: ReserveUpdate = {
    id,
    poolId,
    reserve0: event.params.reserve0,
    reserve1: event.params.reserve1,
    blockTimestampInPool: event.params.blockTimestamp,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.ReserveUpdate.set(reserveUpdate);
});

FPMM.Rebalanced.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch fresh rebalancing state post-rebalance (pinned to event block).
  // Note: eth_call is block-final, not tx-final — accepted approximation for monitoring.
  const rebalancingState = await fetchRebalancingState(
    event.chainId,
    poolId,
    blockNumber,
  );

  const rebalancerAddress = asAddress(event.params.sender);

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {
    lastRebalancedAt: blockTimestamp,
    rebalancerAddress,
    rebalanceLivenessStatus: "ACTIVE",
    // priceDifference comes directly from the event — it is the exact
    // post-rebalance value emitted by the contract, more authoritative than
    // getRebalancingState() which is block-final and may reflect later txs.
    priceDifference: event.params.priceDifferenceAfter,
  };

  if (rebalancingState) {
    // Same inverted-pool logic as UpdateReserves — store feed-direction oracle price.
    const existing = await context.Pool.get(poolId);
    const isInverted = existing?.invertRateFeed ?? false;
    const oraclePrice = isInverted
      ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR;

    oracleDelta = {
      ...oracleDelta,
      oraclePrice,
      rebalanceThreshold: rebalancingState.rebalanceThreshold,
      oracleTimestamp: blockTimestamp,
      oracleTxHash: event.transaction.hash,
    };
  }

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    rebalanceDelta: true,
    oracleDelta,
  });

  // Create OracleSnapshot
  if (rebalancingState) {
    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: oracleDelta.oraclePrice!,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      rebalanceThreshold: pool.rebalanceThreshold,
      source: "rebalanced",
      blockNumber,
    };
    context.OracleSnapshot.set(snapshot);
  }

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    rebalanceDelta: true,
  });

  // Compute rebalance effectiveness metrics
  const priceDifferenceBefore = event.params.priceDifferenceBefore;
  const priceDifferenceAfter = event.params.priceDifferenceAfter;
  const improvement = priceDifferenceBefore - priceDifferenceAfter;
  const effectivenessRatio =
    priceDifferenceBefore > 0n
      ? (Number(improvement) / Number(priceDifferenceBefore)).toFixed(4)
      : "0.0000";

  const rebalanced: RebalanceEvent = {
    id,
    poolId,
    sender: rebalancerAddress,
    caller: event.transaction.from ?? "",
    priceDifferenceBefore,
    priceDifferenceAfter,
    improvement,
    effectivenessRatio,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.RebalanceEvent.set(rebalanced);
});

FPMM.TradingLimitConfigured.handler(async ({ event, context }) => {
  const poolId = asAddress(event.srcAddress);
  const token = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // event.params.config is a tuple [limit0, limit1, decimals] (int120, int120, uint8)
  const configTuple = event.params.config as unknown as [
    bigint,
    bigint,
    number,
  ];
  const eventLimit0 = configTuple[0];
  const eventLimit1 = configTuple[1];
  const eventDecimals = configTuple[2];

  // RPC call to get current state after configuration
  const limits = await fetchTradingLimits(
    event.chainId,
    event.srcAddress,
    event.params.token,
  );

  const limit0 = limits ? limits.config.limit0 : eventLimit0;
  const limit1 = limits ? limits.config.limit1 : eventLimit1;
  const decimals = TRADING_LIMITS_INTERNAL_DECIMALS;
  const netflow0 = limits ? limits.state.netflow0 : 0n;
  const netflow1 = limits ? limits.state.netflow1 : 0n;
  const lastUpdated0 = limits ? BigInt(limits.state.lastUpdated0) : 0n;
  const lastUpdated1 = limits ? BigInt(limits.state.lastUpdated1) : 0n;

  const { p0, p1 } = computeLimitPressures(netflow0, netflow1, limit0, limit1);
  const limitStatus = computeLimitStatus(p0, p1);

  const tl: TradingLimit = {
    id: `${poolId}-${token}`,
    poolId,
    token,
    limit0,
    limit1,
    decimals,
    netflow0,
    netflow1,
    lastUpdated0,
    lastUpdated1,
    limitPressure0: p0.toFixed(4),
    limitPressure1: p1.toFixed(4),
    limitStatus,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  context.TradingLimit.set(tl);

  // Update pool's denormalised limit fields
  const pool = await context.Pool.get(poolId);
  if (pool) {
    context.Pool.set({
      ...pool,
      limitStatus,
      limitPressure0: p0.toFixed(4),
      limitPressure1: p1.toFixed(4),
    });
  }
});

// ---------------------------------------------------------------------------
// FPMM.LiquidityStrategyUpdated — track strategy address on pool
// ---------------------------------------------------------------------------

FPMM.LiquidityStrategyUpdated.handler(async ({ event, context }) => {
  const poolId = asAddress(event.srcAddress);
  const strategy = asAddress(event.params.strategy);
  const status = event.params.status;

  const pool = await context.Pool.get(poolId);
  if (!pool) return;

  if (status) {
    // Strategy enabled — record as rebalancer address
    context.Pool.set({ ...pool, rebalancerAddress: strategy });
  } else if (pool.rebalancerAddress === strategy) {
    // Strategy disabled — clear only if it matches current
    context.Pool.set({ ...pool, rebalancerAddress: "" });
  }
});

// ---------------------------------------------------------------------------
// Event Handlers — SortedOracles (Mainnet only)
// ---------------------------------------------------------------------------

SortedOracles.OracleReported.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Look up all pools using this rateFeedID via DB query (not in-memory map —
  // in-process state is not shared between Envio worker processes).
  const poolIds = await getPoolsByFeed(context, rateFeedID);
  if (poolIds.length === 0) return;

  const oracleTimestamp = event.params.timestamp;
  // Fetch reporter count at this exact block (cached per block — precise in live
  // mode, deduplicated during historical sync).
  const oracleNumReporters = await fetchNumReporters(
    event.chainId,
    rateFeedID,
    BigInt(event.block.number),
  );
  let resolvedOracleExpiry: bigint | null | undefined;

  for (const poolId of poolIds) {
    const existing = await context.Pool.get(poolId);
    if (!existing) continue;

    const oracleExpiry =
      existing.oracleExpiry > 0n
        ? existing.oracleExpiry
        : ((resolvedOracleExpiry ??= await fetchReportExpiry(
            event.chainId,
            rateFeedID,
            blockNumber,
          )) ?? existing.oracleExpiry);

    // Fetch contract's authoritative state (pinned to event block).
    // Both oraclePrice and priceDifference come from the same block-final
    // getRebalancingState() call for internal consistency. Falls back to
    // event.params.value + local computePriceDifference() only when RPC fails.
    // Note: eth_call is block-final, not tx-final — accepted monitoring approximation.
    const rebalancingState = await fetchRebalancingState(
      event.chainId,
      poolId,
      blockNumber,
    );
    const isInverted = existing?.invertRateFeed ?? false;
    const oraclePrice = rebalancingState
      ? isInverted
        ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
        : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR
      : event.params.value;

    const updatedPool: Pool = {
      ...existing,
      oracleTimestamp,
      oracleTxHash: event.transaction.hash,
      oracleOk: true,
      oraclePrice,
      oracleExpiry,
      oracleNumReporters: oracleNumReporters ?? existing.oracleNumReporters,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    };
    const priceDifference = rebalancingState
      ? rebalancingState.priceDifference
      : !updatedPool.source?.includes("virtual") && oraclePrice > 0n
        ? computePriceDifference(updatedPool)
        : updatedPool.priceDifference;
    const rebalanceThreshold =
      rebalancingState?.rebalanceThreshold ?? updatedPool.rebalanceThreshold;
    const withDev = { ...updatedPool, priceDifference, rebalanceThreshold };
    const healthStatus = computeHealthStatus(withDev);
    const finalPool = { ...withDev, healthStatus };
    context.Pool.set(finalPool);

    const snapshot: OracleSnapshot = {
      id:
        eventId(event.chainId, event.block.number, event.logIndex) +
        `-${poolId}`,
      poolId,
      timestamp: blockTimestamp,
      oraclePrice,
      oracleOk: true,
      numReporters: oracleNumReporters ?? existing.oracleNumReporters,
      priceDifference,
      rebalanceThreshold,
      source: "oracle_reported",
      blockNumber,
    };
    context.OracleSnapshot.set(snapshot);
  }
});

SortedOracles.MedianUpdated.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Look up all pools using this rateFeedID via DB query (not in-memory map).
  const poolIds = await getPoolsByFeed(context, rateFeedID);
  if (poolIds.length === 0) return;

  const oracleNumReporters = await fetchNumReporters(
    event.chainId,
    rateFeedID,
    blockNumber,
  );
  let resolvedOracleExpiry: bigint | null | undefined;

  for (const poolId of poolIds) {
    const existing = await context.Pool.get(poolId);
    if (!existing) continue;

    const oracleExpiry =
      existing.oracleExpiry > 0n
        ? existing.oracleExpiry
        : ((resolvedOracleExpiry ??= await fetchReportExpiry(
            event.chainId,
            rateFeedID,
            blockNumber,
          )) ?? existing.oracleExpiry);

    // Fetch contract's authoritative state (pinned to event block).
    // Both oraclePrice and priceDifference come from the same block-final
    // getRebalancingState() call for internal consistency. Falls back to
    // event.params.value + local computePriceDifference() only when RPC fails.
    // Note: eth_call is block-final, not tx-final — accepted monitoring approximation.
    const rebalancingState = await fetchRebalancingState(
      event.chainId,
      poolId,
      blockNumber,
    );
    const isInverted = existing?.invertRateFeed ?? false;
    const oraclePrice = rebalancingState
      ? isInverted
        ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
        : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR
      : event.params.value;

    const updatedPool: Pool = {
      ...existing,
      oraclePrice,
      oracleTimestamp: blockTimestamp,
      oracleTxHash: event.transaction.hash,
      oracleOk: true,
      oracleExpiry,
      oracleNumReporters: oracleNumReporters ?? existing.oracleNumReporters,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    };
    const priceDifference = rebalancingState
      ? rebalancingState.priceDifference
      : !updatedPool.source?.includes("virtual") && oraclePrice > 0n
        ? computePriceDifference(updatedPool)
        : updatedPool.priceDifference;
    const rebalanceThreshold =
      rebalancingState?.rebalanceThreshold ?? updatedPool.rebalanceThreshold;
    const withDev = { ...updatedPool, priceDifference, rebalanceThreshold };
    const healthStatus = computeHealthStatus(withDev);
    const finalPool = { ...withDev, healthStatus };
    context.Pool.set(finalPool);

    const snapshot: OracleSnapshot = {
      id:
        eventId(event.chainId, event.block.number, event.logIndex) +
        `-${poolId}`,
      poolId,
      timestamp: blockTimestamp,
      oraclePrice,
      oracleOk: true,
      numReporters: oracleNumReporters ?? existing.oracleNumReporters,
      priceDifference,
      rebalanceThreshold,
      source: "oracle_median_updated",
      blockNumber,
    };
    context.OracleSnapshot.set(snapshot);
  }
});

SortedOracles.TokenReportExpirySet.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const poolIds = await getPoolsByFeed(context, rateFeedID);
  const oracleExpiry = await fetchReportExpiry(
    event.chainId,
    rateFeedID,
    blockNumber,
  );

  await updatePoolsOracleExpiry(
    context,
    poolIds,
    oracleExpiry,
    blockNumber,
    blockTimestamp,
  );
});

SortedOracles.ReportExpirySet.handler(async ({ event, context }) => {
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const pools = await getPoolsWithReferenceFeed(context);

  for (const pool of pools) {
    const oracleExpiry = await fetchReportExpiry(
      event.chainId,
      pool.referenceRateFeedID,
      blockNumber,
    );
    await updatePoolsOracleExpiry(
      context,
      [pool.id],
      oracleExpiry,
      blockNumber,
      blockTimestamp,
    );
  }
});

// ---------------------------------------------------------------------------
// Event Handlers — VirtualPoolFactory
// ---------------------------------------------------------------------------

VirtualPoolFactory.VirtualPoolDeployed.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);
  const token0 = asAddress(event.params.token0);
  const token1 = asAddress(event.params.token1);

  // VirtualPools don't have oracle functions; set N/A health status
  await upsertPool({
    context,
    poolId,
    token0,
    token1,
    source: "virtual_pool_factory",
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
    oracleDelta: {
      ...DEFAULT_ORACLE_FIELDS,
      healthStatus: "N/A",
    },
  });

  const lifecycle: VirtualPoolLifecycle = {
    id,
    poolId,
    action: "DEPLOYED",
    token0,
    token1,
    factoryAddress: asAddress(event.srcAddress),
    txHash: event.transaction.hash,
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
  };

  context.VirtualPoolLifecycle.set(lifecycle);
});

VirtualPoolFactory.PoolDeprecated.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);

  await upsertPool({
    context,
    poolId,
    source: "virtual_pool_factory",
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
  });

  const lifecycle: VirtualPoolLifecycle = {
    id,
    poolId,
    action: "DEPRECATED",
    token0: undefined,
    token1: undefined,
    factoryAddress: asAddress(event.srcAddress),
    txHash: event.transaction.hash,
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
  };

  context.VirtualPoolLifecycle.set(lifecycle);
});

// ---------------------------------------------------------------------------
// Event Handlers — VirtualPool (swap/reserve tracking; no oracle)
// ---------------------------------------------------------------------------

VirtualPool.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const volume0 =
    event.params.amount0In > event.params.amount0Out
      ? event.params.amount0In
      : event.params.amount0Out;
  const volume1 =
    event.params.amount1In > event.params.amount1Out
      ? event.params.amount1In
      : event.params.amount1Out;

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_swap", // reuse source key; VirtualPool inherits same priority
    blockNumber,
    blockTimestamp,
    swapDelta: { volume0, volume1 },
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    swapDelta: { volume0, volume1 },
  });

  const swap: SwapEvent = {
    id,
    poolId,
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0In: event.params.amount0In,
    amount1In: event.params.amount1In,
    amount0Out: event.params.amount0Out,
    amount1Out: event.params.amount1Out,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.SwapEvent.set(swap);
});

VirtualPool.Mint.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_mint",
    blockNumber,
    blockTimestamp,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    mintDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    poolId,
    kind: "MINT",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

VirtualPool.Burn.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_burn",
    blockNumber,
    blockTimestamp,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    burnDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    poolId,
    kind: "BURN",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

VirtualPool.UpdateReserves.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // VirtualPools have no oracle; just update reserves
  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_update_reserves",
    blockNumber,
    blockTimestamp,
    reservesDelta: {
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    },
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
  });

  const reserveUpdate: ReserveUpdate = {
    id,
    poolId,
    reserve0: event.params.reserve0,
    reserve1: event.params.reserve1,
    blockTimestampInPool: event.params.blockTimestamp,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.ReserveUpdate.set(reserveUpdate);
});

VirtualPool.Rebalanced.handler(async ({ event, context }) => {
  // VirtualPools shouldn't normally rebalance, but handle defensively
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    rebalanceDelta: true,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    rebalanceDelta: true,
  });

  // Compute rebalance effectiveness metrics
  const priceDifferenceBefore = event.params.priceDifferenceBefore;
  const priceDifferenceAfter = event.params.priceDifferenceAfter;
  const improvement = priceDifferenceBefore - priceDifferenceAfter;
  const effectivenessRatio =
    priceDifferenceBefore > 0n
      ? (Number(improvement) / Number(priceDifferenceBefore)).toFixed(4)
      : "0.0000";

  const rebalanced: RebalanceEvent = {
    id,
    poolId,
    sender: asAddress(event.params.sender),
    caller: event.transaction.from ?? "",
    priceDifferenceBefore,
    priceDifferenceAfter,
    improvement,
    effectivenessRatio,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.RebalanceEvent.set(rebalanced);
});

// ---------------------------------------------------------------------------
// Gap-Filling Note:
// ---------------------------------------------------------------------------
// Block handlers in Envio don't provide block.timestamp (only number/chainId).
// For true hourly snapshots during quiet periods, options are:
// 1. External cron job that queries chain and writes to DB
// 2. Envio ClickHouse sink (roadmap)
// 3. Dashboard-side forward-fill (simplest for now)
//
// Current approach: Event-driven snapshots + forward-fill in dashboard charts.
