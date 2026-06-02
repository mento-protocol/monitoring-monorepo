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
// Test mocks: referenceRateFeedID & reportExpiry (for self-heal testing)
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
  }
}

export function _clearMockReportExpiry(): void {
  _testReportExpiry.clear();
  clearTestRpcMockGroup("reportExpiry");
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
