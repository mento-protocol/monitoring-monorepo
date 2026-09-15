// v2 Broker trading-limit fetcher. Modelled on `fetchTradingLimits` in
// `pool-state.ts`: both getters are auto-generated mapping getters with FLAT
// outputs, and both reads must be pinned to the triggering event's block.

import { BROKER_TRADING_LIMITS_ABI } from "../abis.js";
import type {
  BrokerLimitConfig,
  BrokerLimitState,
} from "../brokerTradingLimits.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { consoleLogger, type RpcLogger } from "./log.js";

export type BrokerTradingLimitRead = {
  /** Null when the caller already has the config from a
   * `TradingLimitConfigured` event and asked for state only. */
  config: BrokerLimitConfig | null;
  state: BrokerLimitState;
};

// viem decodes int48 / uint32 / uint8 to JS numbers (all well inside
// Number.MAX_SAFE_INTEGER), so the flat outputs arrive as a number tuple.
function decodeState(raw: unknown): BrokerLimitState {
  const [lastUpdated0, lastUpdated1, netflow0, netflow1, netflowGlobal] =
    raw as readonly number[];
  return {
    lastUpdated0: BigInt(lastUpdated0 ?? 0),
    lastUpdated1: BigInt(lastUpdated1 ?? 0),
    netflow0: BigInt(netflow0 ?? 0),
    netflow1: BigInt(netflow1 ?? 0),
    netflowGlobal: BigInt(netflowGlobal ?? 0),
  };
}

function decodeConfig(raw: unknown): BrokerLimitConfig {
  const [timestep0, timestep1, limit0, limit1, limitGlobal, flags] =
    raw as readonly number[];
  return {
    timestep0: BigInt(timestep0 ?? 0),
    timestep1: BigInt(timestep1 ?? 0),
    limit0: BigInt(limit0 ?? 0),
    limit1: BigInt(limit1 ?? 0),
    limitGlobal: BigInt(limitGlobal ?? 0),
    flags: Number(flags ?? 0),
  };
}

/**
 * Read one `limitId`'s state, and its config when `readConfig` is set, at
 * `blockNumber`.
 *
 * Netflow accumulates with every swap, so a `latest`-block fallback is
 * fundamentally non-historical — the same rule `fetchTradingLimits` enforces.
 * Reject on EITHER read: a config from `latest` paired with an at-block state
 * would compute pressure against a limit the chain did not have at that block.
 */
export async function fetchBrokerTradingLimit(args: {
  chainId: number;
  brokerAddress: string;
  limitId: string;
  blockNumber: bigint;
  /** False when the caller already has the config from a
   * `TradingLimitConfigured` event; saves one eth_call per read. */
  readConfig: boolean;
  log?: RpcLogger;
}): Promise<BrokerTradingLimitRead | null> {
  const { chainId, brokerAddress, limitId, blockNumber } = args;
  const log = args.log ?? consoleLogger;
  let functionName = "tradingLimitsState";
  const read = async (fn: string) =>
    readContractWithBlockFallback(
      chainId,
      getRpcClient(chainId),
      {
        address: brokerAddress as `0x${string}`,
        abi: BROKER_TRADING_LIMITS_ABI,
        functionName: fn,
        args: [limitId as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
  try {
    const stateRead = await read(functionName);
    if (stateRead.usedLatestFallback) return null;
    const state = decodeState(stateRead.result);
    if (!args.readConfig) return { config: null, state };

    functionName = "tradingLimitsConfig";
    const configRead = await read(functionName);
    if (configRead.usedLatestFallback) return null;
    return { config: decodeConfig(configRead.result), state };
  } catch (err) {
    logRpcFailure(chainId, functionName, brokerAddress, err, blockNumber, log);
    return null;
  }
}
