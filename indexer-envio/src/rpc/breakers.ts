// BreakerBox gates trading per rateFeed. RPC cache keys include chainId so
// state cannot bleed across v3 multichain indexing.

import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import {
  readContractWithBlockFallback,
  type BlockFallbackResult,
} from "./block-fallback.js";
import { consoleLogger, type RpcLogger } from "./log.js";
import {
  BREAKER_BOX_ABI,
  MEDIAN_DELTA_BREAKER_ABI,
  VALUE_DELTA_BREAKER_ABI,
} from "../abis.js";
import {
  lookupBreakerKind,
  requireContractAddress,
} from "../contractAddresses.js";
import {
  clearBreakerHttpMocks,
  registerMockBreakerDefaultsHttp,
  registerMockBreakerFeedStateHttp,
  registerMockBreakerKindHttp,
  registerMockBreakerListHttp,
} from "./http-test-mock-bridge.js";

export type BreakerKindRpc = "MEDIAN_DELTA" | "VALUE_DELTA" | "MARKET_HOURS";

const _testBreakerList = new Map<number, string[] | null>();

/** @internal Test-only: pre-set the BreakerBox.getBreakers() result. */
export function _setMockBreakerList(
  chainId: number,
  breakers: string[] | null,
): void {
  _testBreakerList.set(chainId, breakers);
  registerMockBreakerListHttp(chainId, breakers);
}

/** Returns all breaker addresses registered with BreakerBox at `blockNumber`,
 * or null if RPC fails / BreakerBox is not deployed on this chain. Used by
 * the eager bootstrap path: when a feed has no BreakerConfig rows but is
 * receiving MedianUpdated events, enumerate breakers and seed configs. */
export async function fetchBreakerList(
  chainId: number,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<string[] | null> {
  if (_testBreakerList.has(chainId)) return _testBreakerList.get(chainId)!;

  let breakerBoxAddress: `0x${string}`;
  try {
    breakerBoxAddress = requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }

  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: breakerBoxAddress,
        abi: [
          {
            type: "function",
            name: "getBreakers",
            inputs: [],
            outputs: [{ name: "", type: "address[]" }],
            stateMutability: "view",
          },
        ],
        functionName: "getBreakers",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    // Breaker registration is governance-controlled and changes over time
    // (BreakerAdded/Removed events). A `latest`-block fallback would seed
    // current breakers under an old `registeredAtBlock`, so refuse and
    // let the bootstrap retry on the next event for this feed.
    if (usedLatestFallback) return null;
    return (result as readonly string[]).map((a) => a.toLowerCase());
  } catch (err) {
    logRpcFailure(
      chainId,
      "fetchBreakerList",
      breakerBoxAddress,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

export type BreakerDefaults = {
  activatesTradingMode: number;
  defaultCooldownTime: bigint;
  defaultRateChangeThreshold: bigint;
};

export type BreakerFeedState = {
  enabled: boolean;
  tradingMode: number;
  lastStatusUpdatedAt: bigint;
  cooldownTime: bigint;
  rateChangeThreshold: bigint;
  // MD-only — null on VD / MARKET_HOURS.
  smoothingFactor: bigint | null;
  medianRatesEMA: bigint | null;
  // VD-only — null on MD / MARKET_HOURS.
  referenceValue: bigint | null;
};

// ---- Test mock hooks ----

const _testBreakerKinds = new Map<string, BreakerKindRpc | null>();
const _testBreakerDefaults = new Map<string, BreakerDefaults | null>();
const _testBreakerFeedState = new Map<string, BreakerFeedState | null>();

function breakerKindKey(chainId: number, breakerAddress: string): string {
  return `${chainId}:${breakerAddress.toLowerCase()}`;
}
function breakerFeedStateKey(
  chainId: number,
  breakerAddress: string,
  rateFeedID: string,
): string {
  return `${chainId}:${breakerAddress.toLowerCase()}:${rateFeedID.toLowerCase()}`;
}

/** @internal Test-only: pre-set a BreakerKind probe result. */
export function _setMockBreakerKind(
  chainId: number,
  breakerAddress: string,
  kind: BreakerKindRpc | null,
): void {
  _testBreakerKinds.set(breakerKindKey(chainId, breakerAddress), kind);
  registerMockBreakerKindHttp(chainId, breakerAddress, kind);
}

/** @internal Test-only: pre-set Breaker defaults (activatesTradingMode / cooldown / threshold). */
export function _setMockBreakerDefaults(
  chainId: number,
  breakerAddress: string,
  defaults: BreakerDefaults | null,
): void {
  _testBreakerDefaults.set(breakerKindKey(chainId, breakerAddress), defaults);
  registerMockBreakerDefaultsHttp(chainId, breakerAddress, defaults);
}

/** @internal Test-only: pre-set BreakerConfig per-feed RPC state. */
export function _setMockBreakerFeedState(
  chainId: number,
  breakerAddress: string,
  rateFeedID: string,
  state: BreakerFeedState | null,
): void {
  _testBreakerFeedState.set(
    breakerFeedStateKey(chainId, breakerAddress, rateFeedID),
    state,
  );
  registerMockBreakerFeedStateHttp(chainId, breakerAddress, rateFeedID, state);
}

/** @internal Test-only: clear all breaker mocks. */
export function _clearBreakerMocks(): void {
  _testBreakerKinds.clear();
  _testBreakerDefaults.clear();
  _testBreakerFeedState.clear();
  _testBreakerList.clear();
  clearBreakerHttpMocks();
}

// ---- Probes & fetchers ----

/** Probe whether a breaker contract responds to a function. Returns true if
 * the call succeeds (even with zero result), false on revert. */
async function probeFunction(
  chainId: number,
  address: string,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
  log: RpcLogger = consoleLogger,
): Promise<"present" | "missing" | "rpc_error"> {
  try {
    const client = getRpcClient(chainId);
    await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: address as `0x${string}`,
        abi: abi as never,
        functionName,
        args: args as never,
      },
      undefined,
      getFallbackRpcClient(chainId),
      log,
    );
    return "present";
  } catch (err) {
    // Two viem shapes signal "selector not in bytecode":
    //   (a) ContractFunctionZeroDataError — message contains
    //       `returned no data ("0x")` (old fallback() returns empty).
    //   (b) ContractFunctionExecutionError whose shortMessage ends in the
    //       bare `reverted.` suffix — modern Solidity dispatcher reverts
    //       with no reason on missing selector. Verified against
    //       forno.celo.org with viem 2.x on all three live Celo breakers.
    // Reverts WITH a reason/signature/custom-error suffix mean the
    // function exists but failed (require/typed-revert) — those must
    // route to rpc_error so the caller can retry on the next event.
    // INVARIANT for probe callers: only probe pure view functions whose
    // valid-input path cannot bare-revert (`revert()`/`require(false)` with
    // no reason). Today's probes (`medianRatesEMA`, `referenceValues`) are
    // storage getters that return 0 when unset; a future probe that can
    // bare-revert on inputs would mis-classify the breaker kind here.
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("returned no data")) return "missing";
    const shortMessage =
      err &&
      typeof err === "object" &&
      "shortMessage" in err &&
      typeof (err as { shortMessage?: unknown }).shortMessage === "string"
        ? (err as { shortMessage: string }).shortMessage
        : (msg.split("\n", 1)[0] ?? "");
    if (
      err instanceof Error &&
      err.name === "ContractFunctionExecutionError" &&
      shortMessage.endsWith("reverted.")
    ) {
      return "missing";
    }
    logRpcFailure(
      chainId,
      `probe:${functionName}`,
      address,
      err,
      undefined,
      log,
    );
    return "rpc_error";
  }
}

/** Classify a breaker. Known deployment addresses come from
 * @mento-protocol/contracts; selector probes are only the fallback for
 * unknown addresses. Probe order matters: MarketHours has neither
 * `medianRatesEMA` nor `referenceValues`, so we check MD-specific first,
 * then VD-specific, then default to MARKET_HOURS. The probe address
 * (`0x000...0001`) is a valid input that won't have any state — we only care
 * whether the function exists in the bytecode. Returns null on transient
 * RPC failure so the caller can retry rather than poisoning the kind. */
export async function fetchBreakerKind(
  chainId: number,
  breakerAddress: string,
  log: RpcLogger = consoleLogger,
): Promise<BreakerKindRpc | null> {
  const mock = _testBreakerKinds.get(breakerKindKey(chainId, breakerAddress));
  if (mock !== undefined) return mock ?? "MARKET_HOURS";

  const knownKind = lookupBreakerKind(chainId, breakerAddress);
  if (knownKind) return knownKind;

  const probeAddr = "0x0000000000000000000000000000000000000001";
  const mdProbe = await probeFunction(
    chainId,
    breakerAddress,
    MEDIAN_DELTA_BREAKER_ABI,
    "medianRatesEMA",
    [probeAddr],
    log,
  );
  if (mdProbe === "rpc_error") return null;
  if (mdProbe === "present") return "MEDIAN_DELTA";

  const vdProbe = await probeFunction(
    chainId,
    breakerAddress,
    VALUE_DELTA_BREAKER_ABI,
    "referenceValues",
    [probeAddr],
    log,
  );
  if (vdProbe === "rpc_error") return null;
  if (vdProbe === "present") return "VALUE_DELTA";

  // Both selectors confirmed missing — assume MarketHours-style breaker.
  // Containment: `breakerKindEffect` opts out of persistent cache on
  // MARKET_HOURS so an unknown-breaker misclassification (future kind,
  // proxy upgrade, EOA added via governance) cannot survive a restart.
  // The Breaker entity row still pins the kind once written; a mid-stream
  // misclassification requires manual re-sync. The warn signature
  // `breakers.fetchBreakerKind.market_hours_default` is wired to Loki.
  log.warn(
    `breakers.fetchBreakerKind.market_hours_default chain=${chainId} breaker=${breakerAddress} — neither MedianDelta nor ValueDelta selectors present; defaulting to MARKET_HOURS (not cached)`,
  );
  return "MARKET_HOURS";
}

/** Fetch breaker defaults from RPC. `activatesTradingMode` comes from
 * `BreakerBox.breakerTradingMode(breaker)`; `defaultCooldownTime` /
 * `defaultRateChangeThreshold` come from the breaker contract itself
 * (revert-safe — MarketHours has neither and falls back to 0). */
export async function fetchBreakerDefaults(
  chainId: number,
  breakerAddress: string,
  kind: BreakerKindRpc,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<BreakerDefaults | null> {
  const cached = _testBreakerDefaults.get(
    breakerKindKey(chainId, breakerAddress),
  );
  if (cached !== undefined) return cached;

  let breakerBoxAddress: `0x${string}`;
  try {
    breakerBoxAddress = requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }

  try {
    const client = getRpcClient(chainId);
    const fallback = getFallbackRpcClient(chainId);
    const tradingModeP = readContractWithBlockFallback(
      chainId,
      client,
      {
        address: breakerBoxAddress,
        abi: BREAKER_BOX_ABI,
        functionName: "breakerTradingMode",
        args: [breakerAddress as `0x${string}`],
      },
      blockNumber,
      fallback,
      log,
    );

    if (kind === "MARKET_HOURS") {
      const tm = await tradingModeP;
      // Reject latest-block fallback — see comment in the multi-read branch.
      if (tm.usedLatestFallback) return null;
      return {
        activatesTradingMode: Number(tm.result as number),
        defaultCooldownTime: 0n,
        defaultRateChangeThreshold: 0n,
      };
    }

    const breakerAbi =
      kind === "MEDIAN_DELTA"
        ? MEDIAN_DELTA_BREAKER_ABI
        : VALUE_DELTA_BREAKER_ABI;
    const [tmRes, cdRes, thrRes] = await Promise.all([
      tradingModeP,
      readContractWithBlockFallback(
        chainId,
        client,
        {
          address: breakerAddress as `0x${string}`,
          abi: breakerAbi,
          functionName: "defaultCooldownTime",
        },
        blockNumber,
        fallback,
        log,
      ),
      readContractWithBlockFallback(
        chainId,
        client,
        {
          address: breakerAddress as `0x${string}`,
          abi: breakerAbi,
          functionName: "defaultRateChangeThreshold",
        },
        blockNumber,
        fallback,
        log,
      ),
    ]);
    // Breaker defaults change with governance (DefaultCooldownTimeUpdated /
    // DefaultRateChangeThresholdUpdated events). If ANY of the three reads
    // fell back to `latest`, fail closed — bootstrap re-runs on the next
    // event and re-attempts. Persisting current defaults under a historical
    // `registeredAtBlock` would silently corrupt the Breaker entity.
    if (
      tmRes.usedLatestFallback ||
      cdRes.usedLatestFallback ||
      thrRes.usedLatestFallback
    )
      return null;
    return {
      activatesTradingMode: Number(tmRes.result as number),
      defaultCooldownTime: cdRes.result as bigint,
      defaultRateChangeThreshold: thrRes.result as bigint,
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "fetchBreakerDefaults",
      breakerAddress,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

/** Fetch full per-feed breaker state from RPC. Bundles
 * `BreakerBox.rateFeedBreakerStatus` + per-feed config + (kind-specific)
 * `medianRatesEMA` / `smoothingFactors` / `referenceValues`. Returns null if
 * any required call fails — caller decides whether to fall back to defaults
 * (sentinel 0) or skip. */
export async function fetchBreakerFeedState(
  chainId: number,
  breakerAddress: string,
  kind: BreakerKindRpc,
  rateFeedID: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<BreakerFeedState | null> {
  const mock = _testBreakerFeedState.get(
    breakerFeedStateKey(chainId, breakerAddress, rateFeedID),
  );
  if (mock !== undefined) return mock;

  let breakerBoxAddress: `0x${string}`;
  try {
    breakerBoxAddress = requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }

  try {
    const client = getRpcClient(chainId);
    const fallback = getFallbackRpcClient(chainId);
    const statusP = readContractWithBlockFallback(
      chainId,
      client,
      {
        address: breakerBoxAddress,
        abi: BREAKER_BOX_ABI,
        functionName: "rateFeedBreakerStatus",
        args: [rateFeedID as `0x${string}`, breakerAddress as `0x${string}`],
      },
      blockNumber,
      fallback,
      log,
    );

    if (kind === "MARKET_HOURS") {
      const s = await statusP;
      // Reject latest-block fallback — see comment in the multi-read branch.
      if (s.usedLatestFallback) return null;
      const status = parseRateFeedBreakerStatus(s.result);
      return {
        enabled: status.enabled,
        tradingMode: status.tradingMode,
        lastStatusUpdatedAt: status.lastUpdatedTime,
        cooldownTime: 0n,
        rateChangeThreshold: 0n,
        smoothingFactor: null,
        medianRatesEMA: null,
        referenceValue: null,
      };
    }

    const breakerAbi =
      kind === "MEDIAN_DELTA"
        ? MEDIAN_DELTA_BREAKER_ABI
        : VALUE_DELTA_BREAKER_ABI;

    const [statusRes, cdRes, thrRes, kindSpecific] = await Promise.all([
      statusP,
      readContractWithBlockFallback(
        chainId,
        client,
        {
          address: breakerAddress as `0x${string}`,
          abi: breakerAbi,
          functionName: "rateFeedCooldownTime",
          args: [rateFeedID as `0x${string}`],
        },
        blockNumber,
        fallback,
        log,
      ),
      readContractWithBlockFallback(
        chainId,
        client,
        {
          address: breakerAddress as `0x${string}`,
          abi: breakerAbi,
          functionName: "rateChangeThreshold",
          args: [rateFeedID as `0x${string}`],
        },
        blockNumber,
        fallback,
        log,
      ),
      kind === "MEDIAN_DELTA"
        ? Promise.all([
            readContractWithBlockFallback(
              chainId,
              client,
              {
                address: breakerAddress as `0x${string}`,
                abi: MEDIAN_DELTA_BREAKER_ABI,
                functionName: "smoothingFactors",
                args: [rateFeedID as `0x${string}`],
              },
              blockNumber,
              fallback,
              log,
            ),
            readContractWithBlockFallback(
              chainId,
              client,
              {
                address: breakerAddress as `0x${string}`,
                abi: MEDIAN_DELTA_BREAKER_ABI,
                functionName: "medianRatesEMA",
                args: [rateFeedID as `0x${string}`],
              },
              blockNumber,
              fallback,
              log,
            ),
          ])
        : readContractWithBlockFallback(
            chainId,
            client,
            {
              address: breakerAddress as `0x${string}`,
              abi: VALUE_DELTA_BREAKER_ABI,
              functionName: "referenceValues",
              args: [rateFeedID as `0x${string}`],
            },
            blockNumber,
            fallback,
            log,
          ),
    ]);

    // Reject latest-block fallback on any of the per-feed reads. Breaker
    // feed state (status/cooldown/threshold/EMA/reference) is governance-
    // controlled and accumulates with each MedianUpdated, so a `latest`-
    // block stand-in for a historical block would corrupt the BreakerConfig
    // entity. Bootstrap re-runs on the next event for this feed and tries
    // again with fresher chain progress.
    if (statusRes.usedLatestFallback) return null;
    if (cdRes.usedLatestFallback) return null;
    if (thrRes.usedLatestFallback) return null;
    const status = parseRateFeedBreakerStatus(statusRes.result);
    if (kind === "MEDIAN_DELTA") {
      const [sfRes, emaRes] = kindSpecific as [
        BlockFallbackResult,
        BlockFallbackResult,
      ];
      if (sfRes.usedLatestFallback) return null;
      if (emaRes.usedLatestFallback) return null;
      return {
        enabled: status.enabled,
        tradingMode: status.tradingMode,
        lastStatusUpdatedAt: status.lastUpdatedTime,
        cooldownTime: cdRes.result as bigint,
        rateChangeThreshold: thrRes.result as bigint,
        smoothingFactor: sfRes.result as bigint,
        medianRatesEMA: emaRes.result as bigint,
        referenceValue: null,
      };
    }
    const refRes = kindSpecific as BlockFallbackResult;
    if (refRes.usedLatestFallback) return null;
    return {
      enabled: status.enabled,
      tradingMode: status.tradingMode,
      lastStatusUpdatedAt: status.lastUpdatedTime,
      cooldownTime: cdRes.result as bigint,
      rateChangeThreshold: thrRes.result as bigint,
      smoothingFactor: null,
      medianRatesEMA: null,
      referenceValue: refRes.result as bigint,
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "fetchBreakerFeedState",
      `${breakerAddress}:${rateFeedID}`,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

/** viem decodes named struct outputs as objects, anonymous outputs as tuples.
 * `rateFeedBreakerStatus` has named outputs so this should always be the
 * object form, but we support tuple form defensively. */
function parseRateFeedBreakerStatus(raw: unknown): {
  tradingMode: number;
  lastUpdatedTime: bigint;
  enabled: boolean;
} {
  if (Array.isArray(raw)) {
    return {
      tradingMode: Number(raw[0]),
      lastUpdatedTime: BigInt(raw[1] as bigint | number),
      enabled: Boolean(raw[2]),
    };
  }
  const obj = raw as {
    tradingMode: number | bigint;
    lastUpdatedTime: number | bigint;
    enabled: boolean;
  };
  return {
    tradingMode: Number(obj.tradingMode),
    lastUpdatedTime: BigInt(obj.lastUpdatedTime),
    enabled: Boolean(obj.enabled),
  };
}

// ---------------------------------------------------------------------------
// BreakerBox rate-feed dependencies (#712)
//
// On-chain `getRateFeedTradingMode(feed)` ORs in each dependency feed's OWN
// trading mode (one level, non-recursive). To model that — and the reverse-edge
// fan-out — we read the current dependency set per feed. There is no bulk
// getter and the array is wholesale-replaced via `setRateFeedDependencies`, so
// we walk the public array getter `rateFeedDependencies(feed, i)` until it
// reverts (out-of-bounds), then reconcile.
//
// CRITICAL — out-of-bounds is NOT a decodable revert on the prod RPC. forno
// (and QuickNode) report an out-of-bounds array read as a generic
// `ContractFunctionExecutionError: "Missing or invalid parameters…"` with no
// revert data — the exact phrasing block-fallback.ts also treats as a transient
// rejection. A getter failure is therefore indistinguishable, by message or
// error type, from a real provider outage. We disambiguate with a CONTROL read:
// if `getRateFeeds()` succeeds at the same block the node is healthy, so the
// getter failure is a genuine end-of-array; if the control ALSO fails it's
// transient → return null so the caller retries (never truncate the set on a
// blip). Blip-resistance: when ENVIO_RPC_FALLBACK_URL_<chain> is configured,
// readContractWithBlockFallback cross-checks the terminating read on the
// secondary node; if no fallback is set, a single-call blip surviving the
// control read could truncate — self-healed by the next RateFeedDependenciesSet
// or a process restart, and verified post-deploy against the known edges.
//
// (Defined at file end so insertions don't shift the line-keyed ESLint baseline
// entries for fetchBreakerDefaults / fetchBreakerFeedState above.)
// ---------------------------------------------------------------------------

const RATE_FEED_DEPENDENCIES_ABI = [
  {
    type: "function",
    name: "rateFeedDependencies",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const;

const GET_RATE_FEEDS_ABI = [
  {
    type: "function",
    name: "getRateFeeds",
    inputs: [],
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
  },
] as const;

// Safety cap: today the most-connected feed has 2 dependencies; 32 leaves ample
// headroom while bounding the loop if a node ever returns successes without an
// out-of-bounds terminator.
const RATE_FEED_DEPENDENCIES_MAX = 32;

type DepReadCtx = {
  chainId: number;
  breakerBoxAddress: `0x${string}`;
  client: ReturnType<typeof getRpcClient>;
  fallback: ReturnType<typeof getFallbackRpcClient>;
  blockNumber: bigint;
  log: RpcLogger;
};

type DepRead =
  | { kind: "addr"; addr: string }
  | { kind: "empty" }
  | { kind: "transient" };

/** True when `getRateFeeds()` returns at the requested block — proves the node
 * is responsive, so a sibling getter failure is a genuine contract revert
 * (out-of-bounds) rather than a transient provider rejection. */
async function controlReadHealthy(ctx: DepReadCtx): Promise<boolean> {
  try {
    const { usedLatestFallback } = await readContractWithBlockFallback(
      ctx.chainId,
      ctx.client,
      {
        address: ctx.breakerBoxAddress,
        abi: GET_RATE_FEEDS_ABI,
        functionName: "getRateFeeds",
      },
      ctx.blockNumber,
      ctx.fallback,
      ctx.log,
    );
    return !usedLatestFallback;
  } catch {
    return false;
  }
}

/** Read one dependency slot. A successful read yields the lowercased address.
 * A getter failure is disambiguated by the control read: control-healthy ⇒
 * genuine out-of-bounds (`empty`); control-failed ⇒ `transient`.
 * `usedLatestFallback` is rejected as transient — dependencies are governance-
 * mutable, so a `latest` stand-in for a historical block could read a newer set
 * than existed at the event block. */
async function readDepAtIndex(
  ctx: DepReadCtx,
  feed: string,
  index: number,
): Promise<DepRead> {
  try {
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      ctx.chainId,
      ctx.client,
      {
        address: ctx.breakerBoxAddress,
        abi: RATE_FEED_DEPENDENCIES_ABI,
        functionName: "rateFeedDependencies",
        args: [feed as `0x${string}`, BigInt(index)],
      },
      ctx.blockNumber,
      ctx.fallback,
      ctx.log,
    );
    if (usedLatestFallback) return { kind: "transient" };
    return { kind: "addr", addr: (result as string).toLowerCase() };
  } catch {
    return (await controlReadHealthy(ctx))
      ? { kind: "empty" }
      : { kind: "transient" };
  }
}

/** Returns the current dependency feeds for `rateFeedID` at `blockNumber`
 * (lowercased), or null on a transient RPC failure (caller retries / backs off).
 * An empty array means the feed genuinely has no dependencies (control-read
 * confirmed). See the block comment above for the out-of-bounds rationale. */
export async function fetchRateFeedDependencies(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<string[] | null> {
  let breakerBoxAddress: `0x${string}`;
  try {
    breakerBoxAddress = requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }

  const ctx: DepReadCtx = {
    chainId,
    breakerBoxAddress,
    client: getRpcClient(chainId),
    fallback: getFallbackRpcClient(chainId),
    blockNumber,
    log,
  };
  const deps: string[] = [];
  for (let i = 0; i < RATE_FEED_DEPENDENCIES_MAX; i++) {
    const r = await readDepAtIndex(ctx, rateFeedID, i);
    if (r.kind === "addr") {
      deps.push(r.addr);
      continue;
    }
    if (r.kind === "empty") return deps;
    return null; // transient — caller retries on the next event
  }
  log.warn(
    `breakers.fetchRateFeedDependencies.cap_hit chain=${chainId} feed=${rateFeedID} — reached ${RATE_FEED_DEPENDENCIES_MAX} dependencies without an out-of-bounds terminator`,
  );
  return deps;
}
