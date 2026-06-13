import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { consoleLogger, type RpcLogger } from "./log.js";

type BlockWithTimestamp = {
  readonly timestamp?: bigint | number;
};

function normalizeBlockTimestamp(block: unknown): bigint | null {
  if (typeof block !== "object" || block === null) return null;
  const timestamp = (block as BlockWithTimestamp).timestamp;
  if (typeof timestamp === "bigint") return timestamp;
  if (typeof timestamp === "number" && Number.isInteger(timestamp)) {
    return BigInt(timestamp);
  }
  return null;
}

export async function fetchBlockTimestamp(
  chainId: number,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  try {
    const block = await getRpcClient(chainId).getBlock({ blockNumber });
    return normalizeBlockTimestamp(block);
  } catch (err) {
    logRpcFailure(
      chainId,
      "getBlockTimestamp",
      `block:${blockNumber}`,
      err,
      blockNumber,
      log,
    );
    const fallback = getFallbackRpcClient(chainId);
    if (fallback !== null) {
      try {
        const block = await fallback.getBlock({ blockNumber });
        return normalizeBlockTimestamp(block);
      } catch (fallbackErr) {
        logRpcFailure(
          chainId,
          "getBlockTimestampFallback",
          `block:${blockNumber}`,
          fallbackErr,
          blockNumber,
          log,
        );
      }
    }
    return null;
  }
}
