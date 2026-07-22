// SortedOracles and feed metadata RPC fetchers + test mocks.
// Deps flow: oracle-state -> client, block-fallback, abis.

import { FPMM_MINIMAL_ABI, SortedOraclesContract } from "../abis.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { consoleLogger, type RpcLogger } from "./log.js";
import {
  clearTestRpcMockGroup,
  setTestRpcErrorMock,
  setTestRpcMock,
} from "./http-test-mock-bridge.js";

// ---------------------------------------------------------------------------
// Test mocks: referenceRateFeedID, reportExpiry, timestamp-list state, and
// medianTimestamp
// (for self-heal testing)
// ---------------------------------------------------------------------------

const _testRateFeedIDs = new Map<string, string | null>();

/** @internal Test-only: pre-set a mock referenceRateFeedID for a pool. */
export function _setMockRateFeedID(
  chainId: number,
  poolAddress: string,
  rateFeedID: string | null,
): void {
  _testRateFeedIDs.set(`${chainId}:${poolAddress.toLowerCase()}`, rateFeedID);
  if (rateFeedID === null) {
    setTestRpcErrorMock({
      group: "rateFeedID",
      chainId,
      address: poolAddress,
      functionName: "referenceRateFeedID",
    });
  } else {
    setTestRpcMock({
      group: "rateFeedID",
      chainId,
      address: poolAddress,
      functionName: "referenceRateFeedID",
      result: rateFeedID,
    });
  }
}

export function _clearMockRateFeedIDs(): void {
  _testRateFeedIDs.clear();
  clearTestRpcMockGroup("rateFeedID");
}

const _testReportExpiry = new Map<string, bigint | null>();

export type ReportExpiryConfig = {
  globalReportExpiry: bigint;
  tokenReportExpiry: bigint;
  reportExpiry: bigint;
};

const _testReportExpiryConfig = new Map<string, ReportExpiryConfig | null>();

/** @internal Test-only: pre-set a mock report expiry for a rateFeedID. */
export function _setMockReportExpiry(
  chainId: number,
  rateFeedID: string,
  expiry: bigint | null,
): void {
  _testReportExpiry.set(`${chainId}:${rateFeedID.toLowerCase()}`, expiry);
  let sortedOraclesAddress: string | undefined;
  try {
    sortedOraclesAddress = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return;
  }
  if (expiry === null) {
    setTestRpcErrorMock({
      group: "reportExpiry",
      chainId,
      address: sortedOraclesAddress,
      functionName: "tokenReportExpirySeconds",
      callArgs: [rateFeedID],
    });
  } else {
    setTestRpcMock({
      group: "reportExpiry",
      chainId,
      address: sortedOraclesAddress,
      functionName: "tokenReportExpirySeconds",
      callArgs: [rateFeedID],
      result: expiry,
    });
    setTestRpcMock({
      group: "reportExpiry",
      chainId,
      address: sortedOraclesAddress,
      functionName: "reportExpirySeconds",
      result: expiry,
    });
  }
}

/** @internal Test-only: pre-set raw global/token expiry configuration. */
export function _setMockReportExpiryConfig(
  chainId: number,
  rateFeedID: string,
  config: ReportExpiryConfig | null,
): void {
  const key = `${chainId}:${rateFeedID.toLowerCase()}`;
  _testReportExpiryConfig.set(key, config);
  let sortedOraclesAddress: string | undefined;
  try {
    sortedOraclesAddress = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return;
  }
  if (config === null) {
    setTestRpcErrorMock({
      group: "reportExpiryConfig",
      chainId,
      address: sortedOraclesAddress,
      functionName: "tokenReportExpirySeconds",
      callArgs: [rateFeedID],
    });
    return;
  }
  setTestRpcMock({
    group: "reportExpiryConfig",
    chainId,
    address: sortedOraclesAddress,
    functionName: "tokenReportExpirySeconds",
    callArgs: [rateFeedID],
    result: config.tokenReportExpiry,
  });
  setTestRpcMock({
    group: "reportExpiryConfig",
    chainId,
    address: sortedOraclesAddress,
    functionName: "reportExpirySeconds",
    result: config.globalReportExpiry,
  });
}

export function _clearMockReportExpiry(): void {
  _testReportExpiry.clear();
  _testReportExpiryConfig.clear();
  clearTestRpcMockGroup("reportExpiry");
  clearTestRpcMockGroup("reportExpiryConfig");
}

const _testMedianTimestamp = new Map<string, bigint | null>();
const LEGACY_MEDIAN_TEST_REPORTER =
  "0x0000000000000000000000000000000000000001";

export type OracleReportTimestamps = {
  reporters: string[];
  timestamps: bigint[];
};

const _testOracleReportTimestamps = new Map<
  string,
  OracleReportTimestamps | null
>();

/** @internal Test-only: pre-set getTimestamps response for a rateFeedID. */
export function _setMockOracleReportTimestamps(
  chainId: number,
  rateFeedID: string,
  value: OracleReportTimestamps | null,
): void {
  const key = `${chainId}:${rateFeedID.toLowerCase()}`;
  _testOracleReportTimestamps.set(key, value);
  let sortedOraclesAddress: string | undefined;
  try {
    sortedOraclesAddress = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return;
  }
  if (value === null) {
    setTestRpcErrorMock({
      group: "oracleReportTimestamps",
      chainId,
      address: sortedOraclesAddress,
      functionName: "getTimestamps",
      callArgs: [rateFeedID],
    });
  } else {
    setTestRpcMock({
      group: "oracleReportTimestamps",
      chainId,
      address: sortedOraclesAddress,
      functionName: "getTimestamps",
      callArgs: [rateFeedID],
      result: [value.reporters, value.timestamps, value.reporters.map(() => 0)],
    });
  }
}

export function _clearMockOracleReportTimestamps(): void {
  _testOracleReportTimestamps.clear();
  clearTestRpcMockGroup("oracleReportTimestamps");
}

/** @internal Test-only: pre-set a medianTimestamp response for a rateFeedID. */
export function _setMockMedianTimestamp(
  chainId: number,
  rateFeedID: string,
  timestamp: bigint | null,
): void {
  _testMedianTimestamp.set(`${chainId}:${rateFeedID.toLowerCase()}`, timestamp);
  // Preserve existing handler-test fixtures while OracleReported migrates from
  // one medianTimestamp call per event to one getTimestamps bootstrap per feed.
  _setMockOracleReportTimestamps(
    chainId,
    rateFeedID,
    timestamp === null
      ? null
      : {
          reporters: [LEGACY_MEDIAN_TEST_REPORTER],
          timestamps: [timestamp],
        },
  );
  let sortedOraclesAddress: string | undefined;
  try {
    sortedOraclesAddress = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return;
  }
  if (timestamp === null) {
    setTestRpcErrorMock({
      group: "medianTimestamp",
      chainId,
      address: sortedOraclesAddress,
      functionName: "medianTimestamp",
      callArgs: [rateFeedID],
    });
  } else {
    setTestRpcMock({
      group: "medianTimestamp",
      chainId,
      address: sortedOraclesAddress,
      functionName: "medianTimestamp",
      callArgs: [rateFeedID],
      result: timestamp,
    });
  }
}

export function _clearMockMedianTimestamps(): void {
  _testMedianTimestamp.clear();
  clearTestRpcMockGroup("medianTimestamp");
  _clearMockOracleReportTimestamps();
}

const _testRateFeedOracles = new Map<string, string[] | null>();

/** @internal Test-only: pre-set a mock getOracles response for a rateFeedID. */
export function _setMockRateFeedOracles(
  chainId: number,
  rateFeedID: string,
  oracles: string[] | null,
): void {
  const key = `${chainId}:${rateFeedID.toLowerCase()}`;
  _testRateFeedOracles.set(key, oracles);
  let sortedOraclesAddress: string | undefined;
  try {
    sortedOraclesAddress = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return;
  }
  if (oracles === null) {
    setTestRpcErrorMock({
      group: "rateFeedOracles",
      chainId,
      address: sortedOraclesAddress,
      functionName: "getOracles",
      callArgs: [rateFeedID],
    });
  } else {
    setTestRpcMock({
      group: "rateFeedOracles",
      chainId,
      address: sortedOraclesAddress,
      functionName: "getOracles",
      callArgs: [rateFeedID],
      result: oracles,
    });
  }
}

export function _clearMockRateFeedOracles(): void {
  _testRateFeedOracles.clear();
  clearTestRpcMockGroup("rateFeedOracles");
}

const _testNumReporters = new Map<string, number | null>();

/** @internal Test-only: pre-set a mock numRates response for a rateFeedID. */
export function _setMockNumReporters(
  chainId: number,
  rateFeedID: string,
  numReporters: number | null,
): void {
  const key = `${chainId}:${rateFeedID.toLowerCase()}`;
  _testNumReporters.set(key, numReporters);
  let sortedOraclesAddress: string | undefined;
  try {
    sortedOraclesAddress = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return;
  }
  if (numReporters === null) {
    setTestRpcErrorMock({
      group: "numReporters",
      chainId,
      address: sortedOraclesAddress,
      functionName: "numRates",
      callArgs: [rateFeedID],
    });
  } else {
    setTestRpcMock({
      group: "numReporters",
      chainId,
      address: sortedOraclesAddress,
      functionName: "numRates",
      callArgs: [rateFeedID],
      result: BigInt(numReporters),
    });
  }
}

export function _clearMockNumReporters(): void {
  _testNumReporters.clear();
  clearTestRpcMockGroup("numReporters");
}

/** Returns SortedOracles address for chainId, throws if not in @mento-protocol/contracts. */
const SORTED_ORACLES_ADDRESS = SortedOraclesContract.address;

export async function fetchReferenceRateFeedID(
  chainId: number,
  poolAddress: string,
  log: RpcLogger = consoleLogger,
): Promise<string | null> {
  const mockKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRateFeedIDs.has(mockKey))
    return _testRateFeedIDs.get(mockKey) ?? null;

  try {
    const client = getRpcClient(chainId);
    const { result } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "referenceRateFeedID",
      },
      undefined,
      getFallbackRpcClient(chainId),
      log,
    );
    return (result as string).toLowerCase();
  } catch (err) {
    logRpcFailure(
      chainId,
      "referenceRateFeedID",
      poolAddress,
      err,
      undefined,
      log,
    );
    return null;
  }
}

/** Returns the number of active oracle reporters for the given rateFeedID at
 * the given block, or null on error. Per-batch dedup is handled by
 * `numReportersEffect` in src/rpc/effects.ts. */
export async function fetchNumReporters(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<number | null> {
  const mockKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_testNumReporters.has(mockKey)) {
    return _testNumReporters.get(mockKey) ?? null;
  }

  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address,
        abi: SortedOraclesContract.abi,
        functionName: "numRates",
        args: [rateFeedID as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    // numRates can change with governance (reporter allowlist updates), so
    // a `latest`-block fallback is NOT a valid stand-in for the requested
    // historical block. Reject and let the caller preserve stale state.
    if (usedLatestFallback) return null;
    return Number(result);
  } catch (err) {
    logRpcFailure(chainId, "numRates", rateFeedID, err, blockNumber, log);
    return null;
  }
}

/** Returns active oracle reporter addresses for the given rateFeedID at the
 * requested block, or null on error. A latest-block fallback is rejected:
 * reporter membership is governance-mutable and must match the indexed event
 * window. */
export async function fetchRateFeedOracles(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<string[] | null> {
  const mockKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_testRateFeedOracles.has(mockKey)) {
    const mocked = _testRateFeedOracles.get(mockKey);
    return mocked ? mocked.map((oracle) => oracle.toLowerCase()) : null;
  }

  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address,
        abi: SortedOraclesContract.abi,
        functionName: "getOracles",
        args: [rateFeedID as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback) return null;
    return (result as readonly string[]).map((oracle) => oracle.toLowerCase());
  } catch (err) {
    logRpcFailure(chainId, "getOracles", rateFeedID, err, blockNumber, log);
    return null;
  }
}

/** Returns the active SortedOracles reporter timestamps at the requested
 * block. This is a permanently bounded bootstrap read: handlers persist the
 * result once per tracked feed and then advance it from report/removal events.
 * A latest-block fallback is rejected because it would import future reports
 * into an older replay boundary. */
export async function fetchOracleReportTimestamps(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<OracleReportTimestamps | null> {
  const mockKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_testOracleReportTimestamps.has(mockKey)) {
    const mocked = _testOracleReportTimestamps.get(mockKey);
    return mocked
      ? {
          reporters: mocked.reporters.map((reporter) => reporter.toLowerCase()),
          timestamps: [...mocked.timestamps],
        }
      : null;
  }

  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address,
        abi: SortedOraclesContract.abi,
        functionName: "getTimestamps",
        args: [rateFeedID as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback) return null;
    const [reporters, timestamps] = result as readonly [
      readonly string[],
      readonly bigint[],
      readonly number[],
    ];
    if (reporters.length !== timestamps.length) return null;
    return {
      reporters: reporters.map((reporter) => reporter.toLowerCase()),
      timestamps: [...timestamps],
    };
  } catch (err) {
    logRpcFailure(chainId, "getTimestamps", rateFeedID, err, blockNumber, log);
    return null;
  }
}

function mockedReportExpiryConfig(
  chainId: number,
  rateFeedID: string,
): ReportExpiryConfig | null | undefined {
  const mockKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_testReportExpiryConfig.has(mockKey)) {
    return _testReportExpiryConfig.get(mockKey) ?? null;
  }
  // Existing effective-expiry fixtures predate raw config state. Treat a
  // positive fixture as an active override so old handler tests retain their
  // intended boundary without weakening production validation.
  if (!_testReportExpiry.has(mockKey)) return undefined;
  const reportExpiry = _testReportExpiry.get(mockKey) ?? null;
  if (reportExpiry == null || reportExpiry <= 0n) return null;
  return {
    globalReportExpiry: reportExpiry,
    tokenReportExpiry: reportExpiry,
    reportExpiry,
  };
}

/** Returns raw global/token expiry configuration plus the effective value at
 * one exact block boundary. Both raw values are required to replay later
 * ReportExpirySet and TokenReportExpirySet logs without importing block-close
 * state from a later log. */
export async function fetchReportExpiryConfig(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<ReportExpiryConfig | null> {
  const mocked = mockedReportExpiryConfig(chainId, rateFeedID);
  if (mocked !== undefined) return mocked;

  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }
  try {
    const client = getRpcClient(chainId);
    const fallback = getFallbackRpcClient(chainId);
    const [tokenExpiryRes, globalExpiryRes] = await Promise.all([
      readContractWithBlockFallback(
        chainId,
        client,
        {
          address,
          abi: SortedOraclesContract.abi,
          functionName: "tokenReportExpirySeconds",
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
          address,
          abi: SortedOraclesContract.abi,
          functionName: "reportExpirySeconds",
        },
        blockNumber,
        fallback,
        log,
      ),
    ]);
    if (
      tokenExpiryRes.usedLatestFallback ||
      globalExpiryRes.usedLatestFallback
    ) {
      return null;
    }
    const tokenReportExpiry = tokenExpiryRes.result as bigint;
    const globalReportExpiry = globalExpiryRes.result as bigint;
    if (tokenReportExpiry < 0n || globalReportExpiry <= 0n) return null;
    return {
      globalReportExpiry,
      tokenReportExpiry,
      reportExpiry:
        tokenReportExpiry > 0n ? tokenReportExpiry : globalReportExpiry,
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "reportExpiryConfig",
      rateFeedID,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

/** Returns the effective oracle report expiry (seconds) for the given
 * rateFeedID. Returns null on RPC/address error so callers can preserve the
 * previous known-good value. Concurrent-call dedup (oracle handlers fan out
 * across pools sharing a feed) is handled upstream by `reportExpiryEffect`
 * in src/rpc/effects.ts — Envio's Effect API memoizes per-batch on
 * identical inputs. */
export async function fetchReportExpiry(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  const mockKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_testReportExpiry.has(mockKey))
    return _testReportExpiry.get(mockKey) ?? null;

  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }
  try {
    const client = getRpcClient(chainId);
    const tokenExpiryRes = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address,
        abi: SortedOraclesContract.abi,
        functionName: "tokenReportExpirySeconds",
        args: [rateFeedID as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    // Report expiry can change via governance (TokenReportExpirySet /
    // ReportExpirySet events); a `latest`-block fallback isn't valid for
    // the requested historical block.
    if (tokenExpiryRes.usedLatestFallback) return null;
    const tokenExpiry = tokenExpiryRes.result as bigint;
    let expiry: bigint;
    if (tokenExpiry > 0n) {
      expiry = tokenExpiry;
    } else {
      const globalRes = await readContractWithBlockFallback(
        chainId,
        client,
        {
          address,
          abi: SortedOraclesContract.abi,
          functionName: "reportExpirySeconds",
        },
        blockNumber,
        getFallbackRpcClient(chainId),
        log,
      );
      if (globalRes.usedLatestFallback) return null;
      expiry = globalRes.result as bigint;
    }
    if (expiry <= 0n) return null;
    return expiry;
  } catch (err) {
    logRpcFailure(chainId, "reportExpiry", rateFeedID, err, blockNumber, log);
    return null;
  }
}

/** Returns SortedOracles' authoritative median report timestamp at the
 * requested block. OracleAdapter uses this exact value with the feed expiry
 * to decide whether FPMM reads are valid. A latest-block fallback is rejected:
 * using a newer report while replaying an older event would renew historical
 * freshness and corrupt uptime intervals. */
export async function fetchMedianTimestamp(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  const mockKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_testMedianTimestamp.has(mockKey)) {
    return _testMedianTimestamp.get(mockKey) ?? null;
  }

  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address,
        abi: SortedOraclesContract.abi,
        functionName: "medianTimestamp",
        args: [rateFeedID as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback) return null;
    return result as bigint;
  } catch (err) {
    logRpcFailure(
      chainId,
      "medianTimestamp",
      rateFeedID,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}
