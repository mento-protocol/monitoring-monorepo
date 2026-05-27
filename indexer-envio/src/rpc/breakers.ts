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
  MARKET_HOURS_BREAKER_ABI,
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
    // Distinguish "function not in bytecode" (selector miss) from a
    // transient RPC failure. viem's `ContractFunctionZeroDataError` is the
    // unambiguous signal — its `shortMessage` always contains the exact
    // phrase `returned no data ("0x")`. Matching just `"0x"` (which appears
    // in addresses, calldata, and many provider error payloads) or
    // `"execution reverted"` (which fires when the function EXISTS but
    // throws — e.g. a require() failure on the probe address) would
    // misclassify legitimate RPC/contract errors as selector misses and
    // permanently persist the wrong BreakerKind.
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("returned no data")) return "missing";
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
 * unknown addresses. Probe order: MD-specific (`medianRatesEMA`), then
 * VD-specific (`referenceValues`), then MarketHours-specific
 * (`isFXMarketOpen`). All three are positive probes — an unknown contract
 * that responds to none of them returns null so the caller retries instead
 * of caching a misclassification. The probe address
 * (`0x000...0001`) is a valid input that won't have any state — we only care
 * whether the function exists in the bytecode. Returns null on transient
 * RPC failure too, for the same reason. */
export async function fetchBreakerKind(
  chainId: number,
  breakerAddress: string,
  log: RpcLogger = consoleLogger,
): Promise<BreakerKindRpc | null> {
  const mock = _testBreakerKinds.get(breakerKindKey(chainId, breakerAddress));
  // `null` mock means "unknown" — matches the unknown-kind contract below.
  if (mock !== undefined) return mock;

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

  // Positive MarketHours probe. `isFXMarketOpen(uint256)` is present on every
  // MarketHoursBreaker variant in @mento-protocol/contracts (base, v300, and
  // both Toggleable forms) and absent on MD/VD breakers. A `0` timestamp is a
  // safe pure call — we only care whether the selector exists in bytecode.
  const mhProbe = await probeFunction(
    chainId,
    breakerAddress,
    MARKET_HOURS_BREAKER_ABI,
    "isFXMarketOpen",
    [0n],
    log,
  );
  if (mhProbe === "rpc_error") return null;
  if (mhProbe === "present") return "MARKET_HOURS";

  // No probe matched — return null so `breakerKindEffect` skips the cache
  // and the next event re-probes. Catches future breaker kinds, proxy-
  // upgraded breakers, and EOAs added via governance / RPC poisoning. Loki
  // surfaces this via the `breakers.fetchBreakerKind.unknown_kind` warn.
  log.warn(
    `breakers.fetchBreakerKind.unknown_kind chain=${chainId} breaker=${breakerAddress} — no MedianDelta, ValueDelta, or MarketHours selector present; refusing to cache classification`,
  );
  return null;
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
