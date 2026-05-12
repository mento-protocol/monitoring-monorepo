import { FPMM_FEE_ABI } from "../abis.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { consoleLogger, type RpcLogger } from "./log.js";
import {
  clearTestRpcMockGroup,
  setTestRpcErrorMock,
  setTestRpcMock,
  setTestRpcRawMock,
} from "./http-test-mock-bridge.js";

/** Per-getter mock behavior for fetchFees. */
export type FeeGetterMock =
  | { fulfilled: bigint }
  /** Simulate a transient RPC failure — pool.ts self-heal will retry. */
  | { rejected: "transient" }
  /** Simulate the viem "returned no data (0x)" error that fires when a
   *  getter isn't in the contract bytecode — pool.ts self-heal stamps -2
   *  and stops retrying that field. */
  | { rejected: "unsupported" };

export type FetchFeesMock = {
  lpFee?: FeeGetterMock;
  protocolFee?: FeeGetterMock;
  rebalanceReward?: FeeGetterMock;
  /** Simulate getRpcClient throwing (unknown chain / missing token). */
  rpcClientThrows?: true;
};

const _testFees = new Map<string, FetchFeesMock>();

/** @internal Test-only: override fetchFees' three readContract calls for a
 *  (chain, pool) pair. Pass `null` to clear a specific entry. */
export function _setMockFees(
  chainId: number,
  poolAddress: string,
  mock: FetchFeesMock | null,
): void {
  const key = `${chainId}:${poolAddress.toLowerCase()}`;
  if (mock === null) {
    _testFees.delete(key);
    clearTestRpcMockGroup(`fees:${chainId}:${poolAddress.toLowerCase()}`);
  } else {
    _testFees.set(key, mock);
    const group = `fees:${chainId}:${poolAddress.toLowerCase()}`;
    for (const [field, functionName] of [
      ["lpFee", "lpFee"],
      ["protocolFee", "protocolFee"],
      ["rebalanceReward", "rebalanceIncentive"],
    ] as const) {
      const getterMock = mock[field];
      if (!getterMock) continue;
      if ("fulfilled" in getterMock) {
        setTestRpcMock({
          group,
          chainId,
          address: poolAddress,
          functionName,
          result: getterMock.fulfilled,
        });
      } else if (getterMock.rejected === "unsupported") {
        setTestRpcRawMock({
          group,
          chainId,
          address: poolAddress,
          functionName,
          result: "0x",
        });
      } else {
        setTestRpcErrorMock({
          group,
          chainId,
          address: poolAddress,
          functionName,
        });
      }
    }
  }
}

/** @internal Test-only: clear all fetchFees mocks. */
export function _clearMockFees(): void {
  _testFees.clear();
  clearTestRpcMockGroup("fees");
}

/** viem's `ContractFunctionZeroDataError` (message includes "returned no
 *  data") fires when the called function isn't in the contract bytecode —
 *  distinct from a network / RPC timeout. For fee getters that's the
 *  "older FPMM, getter missing" path, and pool.ts uses -2 to stamp those
 *  fields so self-heal stops retrying. Anything else is treated as
 *  transient and the field keeps the -1 sentinel for retry. */
function isUnsupportedGetterError(reason: unknown): boolean {
  const msg = reason instanceof Error ? reason.message : String(reason);
  return msg.includes("returned no data");
}

async function readFeeGetter(
  client: ReturnType<typeof getRpcClient>,
  chainId: number,
  poolAddress: string,
  functionName: "lpFee" | "protocolFee" | "rebalanceIncentive",
  mock: FeeGetterMock | undefined,
  log: RpcLogger,
): Promise<bigint> {
  if (mock) {
    if ("fulfilled" in mock) return mock.fulfilled;
    if (mock.rejected === "unsupported") {
      throw new Error(
        `The contract function "${functionName}" returned no data ("0x").`,
      );
    }
    throw new Error("Mock transient RPC failure");
  }
  const { result } = await readContractWithBlockFallback(
    chainId,
    client,
    {
      address: poolAddress as `0x${string}`,
      abi: FPMM_FEE_ABI,
      functionName,
    },
    undefined,
    getFallbackRpcClient(chainId),
    log,
  );
  return result as bigint;
}

/** Test-only sentinel: `null` represents an RPC failure mock, distinct
 * from "no mock set" (which falls through to real RPC). */
const _testIncentiveAtBlock = new Map<string, number | null>();

/** @internal Test-only: pre-set a mock for `fetchRebalanceIncentiveAtBlock`.
 *  Pass a number (incl. -2) to return that bps; pass `null` to simulate
 *  RPC failure. Call `_clearMockRebalanceIncentivesAtBlock()` to reset. */
export function _setMockRebalanceIncentiveAtBlock(
  chainId: number,
  poolAddress: string,
  bps: number | null,
): void {
  _testIncentiveAtBlock.set(`${chainId}:${poolAddress.toLowerCase()}`, bps);
  if (bps === null) {
    setTestRpcErrorMock({
      group: "rebalanceIncentiveAtBlock",
      chainId,
      address: poolAddress,
      functionName: "rebalanceIncentive",
    });
  } else {
    setTestRpcMock({
      group: "rebalanceIncentiveAtBlock",
      chainId,
      address: poolAddress,
      functionName: "rebalanceIncentive",
      result: BigInt(bps),
    });
  }
}

/** @internal Test-only: clear all `fetchRebalanceIncentiveAtBlock` mocks. */
export function _clearMockRebalanceIncentivesAtBlock(): void {
  _testIncentiveAtBlock.clear();
  clearTestRpcMockGroup("rebalanceIncentiveAtBlock");
}

/** Read `rebalanceIncentive()` (bps) at a specific block. Used by the
 * Rebalanced handler to stamp the incentive that was actually in force
 * at the rebalance block, instead of inheriting `Pool.rebalanceReward`
 * (which can carry today's value during full resync — `fetchFees` self-
 * heals from `latest`, not block-scoped). On RPC failure or fallback
 * to `latest`, returns null and the caller falls back to the persisted
 * Pool value. The `-2` return value mirrors the `fetchFees` "getter
 * missing on this contract" sentinel — `Pool.rebalanceReward` uses it
 * to halt the upsertPool self-heal retry loop on older FPMM pools, and
 * propagating it here lets the Rebalanced handler short-circuit on
 * subsequent events for the same pool. */
export async function fetchRebalanceIncentiveAtBlock(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<number | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testIncentiveAtBlock.has(testKey)) {
    return _testIncentiveAtBlock.get(testKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_FEE_ABI,
        functionName: "rebalanceIncentive",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    // Only `latest`-block fallback breaks block-scoping; secondary-RPC
    // fallback still queries the requested block, so its result is fine.
    if (usedLatestFallback) return null;
    return Number(result as bigint);
  } catch (err) {
    if (isUnsupportedGetterError(err)) return -2;
    logRpcFailure(
      chainId,
      "rebalanceIncentive",
      poolAddress,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

/** Fetch FPMM fee config (bps): lpFee, protocolFee, rebalanceIncentive.
 * Returns only the fields whose RPC call succeeded so partial failure
 * doesn't overwrite already-populated fields; returns null when every
 * call fails so self-heal retries on the next touch. Fields that reject
 * with the "returned no data" signature get -2 (attempted, unsupported)
 * so self-heal stops retrying permanently-missing getters. */
export async function fetchFees(
  chainId: number,
  poolAddress: string,
  log: RpcLogger = consoleLogger,
): Promise<Partial<{
  lpFee: number;
  protocolFee: number;
  rebalanceReward: number;
}> | null> {
  // Outer try/catch covers getRpcClient, which throws on unknown chainIds
  // or missing HyperRPC tokens — those must degrade to null, not escape
  // into the handler and stall indexing for the rest of the event.
  try {
    const mockKey = `${chainId}:${poolAddress.toLowerCase()}`;
    const mock = _testFees.get(mockKey);
    if (mock?.rpcClientThrows) {
      throw new Error("Mock getRpcClient throw");
    }
    const client = getRpcClient(chainId);
    const results = await Promise.allSettled([
      readFeeGetter(client, chainId, poolAddress, "lpFee", mock?.lpFee, log),
      readFeeGetter(
        client,
        chainId,
        poolAddress,
        "protocolFee",
        mock?.protocolFee,
        log,
      ),
      readFeeGetter(
        client,
        chainId,
        poolAddress,
        "rebalanceIncentive",
        mock?.rebalanceReward,
        log,
      ),
    ]);
    const [lpFeeR, protocolFeeR, rebalanceRewardR] = results;
    if (
      lpFeeR.status === "rejected" &&
      protocolFeeR.status === "rejected" &&
      rebalanceRewardR.status === "rejected"
    ) {
      logRpcFailure(
        chainId,
        "fetchFees",
        poolAddress,
        lpFeeR.reason,
        undefined,
        log,
      );
      return null;
    }
    const fees: Partial<{
      lpFee: number;
      protocolFee: number;
      rebalanceReward: number;
    }> = {};
    if (lpFeeR.status === "fulfilled") {
      fees.lpFee = Number(lpFeeR.value as bigint);
    } else if (isUnsupportedGetterError(lpFeeR.reason)) {
      fees.lpFee = -2;
    }
    if (protocolFeeR.status === "fulfilled") {
      fees.protocolFee = Number(protocolFeeR.value as bigint);
    } else if (isUnsupportedGetterError(protocolFeeR.reason)) {
      fees.protocolFee = -2;
    }
    if (rebalanceRewardR.status === "fulfilled") {
      fees.rebalanceReward = Number(rebalanceRewardR.value as bigint);
    } else if (isUnsupportedGetterError(rebalanceRewardR.reason)) {
      fees.rebalanceReward = -2;
    }
    return fees;
  } catch (err) {
    logRpcFailure(chainId, "fetchFees", poolAddress, err, undefined, log);
    return null;
  }
}
