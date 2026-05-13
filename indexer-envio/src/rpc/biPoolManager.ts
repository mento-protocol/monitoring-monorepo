// BiPoolManager + VirtualPool RPC fetchers — `getPoolExchange` struct read +
// VP bytecode-pattern extraction. Split out of `pool-state.ts` to keep that
// file under the repo's 1000-line cap.
//
// Both fetchers are wired through `rpc/effects.ts` (poolExchangeEffect /
// vpExchangeIdEffect) so handler call sites get per-batch dedup +
// optional persistent caching automatically. Test mocks live in this
// module (re-exported via `rpc.ts`).

import { BI_POOL_MANAGER_GET_POOL_EXCHANGE_ABI } from "../abis.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { consoleLogger, type RpcLogger } from "./log.js";
import {
  clearTestRpcMockGroup,
  setTestGetCodeErrorMock,
  setTestGetCodeMock,
  setTestRpcErrorMock,
  setTestRpcMock,
} from "./http-test-mock-bridge.js";

// ---------------------------------------------------------------------------
// BiPoolManager — getPoolExchange backfill
//
// `ExchangeCreated` carries asset0/asset1/pricingModule but the rest of the
// PoolExchange struct (spread, referenceRateFeedID, reset frequency, …) only
// arrives via the SpreadUpdated / BucketsUpdated sub-events AFTER create.
// `fetchPoolExchange` is called at ExchangeCreated time and from self-heal
// paths when the create event predates the indexer start block, so the
// `BiPoolExchange` row can be fully populated before downstream valuation
// logic depends on the exchange's token metadata.
//
// Returns null on RPC failure. The handler skips the field overwrite on null
// and the next SpreadUpdated / BucketsUpdated event still mutates incrementally.
// ---------------------------------------------------------------------------

export type PoolExchangeStruct = {
  asset0: string;
  asset1: string;
  pricingModule: string;
  bucket0: bigint;
  bucket1: bigint;
  lastBucketUpdate: bigint;
  spread: bigint;
  referenceRateFeedID: string;
  referenceRateResetFrequency: bigint;
  minimumReports: bigint;
  stablePoolResetSize: bigint;
};

const _testPoolExchanges = new Map<string, PoolExchangeStruct | null>();

/** @internal Test-only: pre-set a mock PoolExchange struct keyed by
 *  (chainId, exchangeProvider, exchangeId). Pass `null` to simulate RPC
 *  failure. Call `_clearMockPoolExchanges()` to reset. */
export function _setMockPoolExchange(
  chainId: number,
  exchangeProvider: string,
  exchangeId: string,
  struct: PoolExchangeStruct | null,
): void {
  const key = `${chainId}:${exchangeProvider.toLowerCase()}:${exchangeId.toLowerCase()}`;
  _testPoolExchanges.set(key, struct);
  if (struct === null) {
    setTestRpcErrorMock({
      group: "poolExchange",
      chainId,
      address: exchangeProvider,
      functionName: "getPoolExchange",
      callArgs: [exchangeId],
    });
  } else {
    setTestRpcMock({
      group: "poolExchange",
      chainId,
      address: exchangeProvider,
      functionName: "getPoolExchange",
      callArgs: [exchangeId],
      result: {
        asset0: struct.asset0,
        asset1: struct.asset1,
        pricingModule: struct.pricingModule,
        bucket0: struct.bucket0,
        bucket1: struct.bucket1,
        lastBucketUpdate: struct.lastBucketUpdate,
        config: {
          spread: { value: struct.spread },
          referenceRateFeedID: struct.referenceRateFeedID,
          referenceRateResetFrequency: struct.referenceRateResetFrequency,
          minimumReports: struct.minimumReports,
          stablePoolResetSize: struct.stablePoolResetSize,
        },
      },
    });
  }
}

/** @internal Test-only: clear all PoolExchange mocks. */
export function _clearMockPoolExchanges(): void {
  _testPoolExchanges.clear();
  clearTestRpcMockGroup("poolExchange");
}

export async function fetchPoolExchange(
  chainId: number,
  exchangeProvider: string,
  exchangeId: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<PoolExchangeStruct | null> {
  const mockKey = `${chainId}:${exchangeProvider.toLowerCase()}:${exchangeId.toLowerCase()}`;
  if (_testPoolExchanges.has(mockKey)) {
    return _testPoolExchanges.get(mockKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    // Read at the event block so historical catch-up never stamps a future
    // governance config or destroyed/empty exchange state onto a past row.
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: exchangeProvider as `0x${string}`,
        abi: BI_POOL_MANAGER_GET_POOL_EXCHANGE_ABI,
        functionName: "getPoolExchange",
        args: [exchangeId as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback) return null;
    const r = result as {
      asset0: string;
      asset1: string;
      pricingModule: string;
      bucket0: bigint;
      bucket1: bigint;
      lastBucketUpdate: bigint;
      config: {
        spread: { value: bigint };
        referenceRateFeedID: string;
        referenceRateResetFrequency: bigint;
        minimumReports: bigint;
        stablePoolResetSize: bigint;
      };
    };
    return {
      asset0: r.asset0.toLowerCase(),
      asset1: r.asset1.toLowerCase(),
      pricingModule: r.pricingModule.toLowerCase(),
      bucket0: r.bucket0,
      bucket1: r.bucket1,
      lastBucketUpdate: r.lastBucketUpdate,
      spread: r.config.spread.value,
      referenceRateFeedID: r.config.referenceRateFeedID.toLowerCase(),
      referenceRateResetFrequency: r.config.referenceRateResetFrequency,
      minimumReports: r.config.minimumReports,
      stablePoolResetSize: r.config.stablePoolResetSize,
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "getPoolExchange",
      `${exchangeProvider}:${exchangeId}`,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// VirtualPool — extract wrapped exchangeId from bytecode
//
// Every VirtualPool's `swap()` preamble contains the BiPoolManager address +
// exchangeId as PUSH32 immediates emitted by the compiler in a recognizable
// opcode sequence. The pattern was validated against all 12 deployed Celo
// VPs in PR #359. Extracting at index time means the dashboard's
// VirtualPool→exchange join is a single GraphQL hop instead of an HTTP/RPC
// round-trip per page load.
//
//   PUSH32 <32B mgrAddr>  — capture 1 (right-aligned in 32 bytes; bottom 20B is the address)
//   DUP2 (81) AND (16) PUSH1 0x04 (6004) DUP4 (83) ADD (01) MSTORE (52)
//   PUSH32 <32B exchangeId> — capture 2
//
// Returns `null` (permanent miss) when the address has no bytecode or the
// pattern doesn't match — both are stable classifications safe to cache
// forever. Returns the `RPC_ERROR` sentinel when `getCode` itself rejects;
// callers must NOT cache that case (the next event for the same address
// should retry).
// ---------------------------------------------------------------------------

export type VirtualPoolExchangeId = {
  exchangeProvider: string;
  exchangeId: string;
};

/** Sentinel: bytecode probe failed transiently (RPC threw). Distinct from
 * `null`, which means "got bytecode, definitively not a VP" and is safe
 * to cache as a permanent classification. */
export const VP_PROBE_RPC_ERROR = "rpc-error" as const;
export type VpProbeResult =
  | VirtualPoolExchangeId
  | null
  | typeof VP_PROBE_RPC_ERROR;

const _testVpExchangeIds = new Map<string, VpProbeResult>();

/** @internal Test-only: pre-set a mock VirtualPool exchangeId extraction.
 *  Pass `null` to simulate "not a VP" (no pattern match — permanent miss).
 *  Pass `VP_PROBE_RPC_ERROR` to simulate a transient RPC failure. */
export function _setMockVpExchangeId(
  chainId: number,
  vpAddress: string,
  result: VpProbeResult,
): void {
  const key = `${chainId}:${vpAddress.toLowerCase()}`;
  _testVpExchangeIds.set(key, result);
  if (result === VP_PROBE_RPC_ERROR) {
    setTestGetCodeErrorMock({
      group: "vpExchangeId",
      chainId,
      address: vpAddress,
    });
  } else if (result === null) {
    setTestGetCodeMock({
      group: "vpExchangeId",
      chainId,
      address: vpAddress,
      result: "0x6000",
    });
  } else {
    const provider = result.exchangeProvider.toLowerCase().replace(/^0x/, "");
    const exchangeId = result.exchangeId.toLowerCase().replace(/^0x/, "");
    setTestGetCodeMock({
      group: "vpExchangeId",
      chainId,
      address: vpAddress,
      result: `0x7f${provider.padStart(64, "0")}811660048301527f${exchangeId.padStart(64, "0")}`,
    });
  }
}

/** @internal Test-only: clear all VirtualPool exchangeId mocks. */
export function _clearMockVpExchangeIds(): void {
  _testVpExchangeIds.clear();
  clearTestRpcMockGroup("vpExchangeId");
}

// Compiler-emitted opcode sequence between the two PUSH32 constants:
// 81 (DUP2) 16 (AND) 6004 (PUSH1 0x04) 83 (DUP4) 01 (ADD) 52 (MSTORE) 7f (PUSH32).
const VP_BYTECODE_PATTERN = /7f([0-9a-f]{64})811660048301527f([0-9a-f]{64})/;

export function extractVpExchangeIdFromBytecode(
  code: string,
): VirtualPoolExchangeId | null {
  const match = code.toLowerCase().match(VP_BYTECODE_PATTERN);
  if (!match) return null;
  const [, mgrPadded, rawExchangeId] = match;
  if (!mgrPadded || !rawExchangeId) return null;
  // First match is the address right-aligned in 32 bytes — bottom 20 bytes
  // is the actual address.
  const exchangeProvider = ("0x" + mgrPadded.slice(24)).toLowerCase();
  const exchangeId = ("0x" + rawExchangeId).toLowerCase();
  return { exchangeProvider, exchangeId };
}

export async function fetchVirtualPoolExchangeId(
  chainId: number,
  vpAddress: string,
  log: RpcLogger = consoleLogger,
): Promise<VpProbeResult> {
  const mockKey = `${chainId}:${vpAddress.toLowerCase()}`;
  if (_testVpExchangeIds.has(mockKey)) {
    return _testVpExchangeIds.get(mockKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    const code = await client.getCode({
      address: vpAddress as `0x${string}`,
    });
    // Empty bytecode (`0x` or null) is transient: an Envio sync that
    // observes the deploy event ahead of the configured RPC's view
    // would see no code yet. Caching that as a permanent not-VP would
    // disable healed-VP paths forever for the just-deployed pool.
    // Distinguish it from "got real bytecode but no pattern match"
    // (returned as `null` from `extractVpExchangeIdFromBytecode`),
    // which IS permanent and safe to cache.
    if (!code || code === "0x") return VP_PROBE_RPC_ERROR;
    return extractVpExchangeIdFromBytecode(code);
  } catch (err) {
    logRpcFailure(chainId, "vpExchangeId", vpAddress, err, undefined, log);
    return VP_PROBE_RPC_ERROR;
  }
}
