// ---------------------------------------------------------------------------
// v2 Broker trading limits — pure logic, no I/O.
//
// The Broker keys its `tradingLimitsConfig` / `tradingLimitsState` mappings by
// `limitId = exchangeId XOR bytes32(uint160(token))`. All limit and netflow
// values are WHOLE TOKEN UNITS (int48 on chain), not the 15-decimal internal
// scale of the FPMM `TradingLimit` entity in `tradingLimits.ts`.
// ---------------------------------------------------------------------------

import type { BrokerTradingLimit, Pool } from "envio";

/** TradingLimits flag bits. A window is live only when its bit is set. */
export const LIMIT_FLAG_L0 = 1;
export const LIMIT_FLAG_L1 = 2;
export const LIMIT_FLAG_LG = 4;

/** Minimum age of a stored state read before the next Broker.Swap re-reads it.
 * 300 s costs 31k-53k state reads for a full Celo resync; see ADR 0103. */
export const BROKER_LIMIT_REFRESH_SECONDS = 300n;

/** At or above this pressure a leg is re-read on EVERY swap, not once per
 * refresh window — the alert plane needs the last few percent to be exact. */
export const BROKER_LIMIT_HOT_PRESSURE = 0.8;

const PRESSURE_SCALE = 100_000_000n;
/** Stored/rendered precision for every pressure. `toFixed(4)` rounds, so the
 * status must read the rounded value or the two disagree at a threshold. */
const PRESSURE_DP = 10_000;
const LIMIT_ID_HEX_DIGITS = 64;

export type BrokerLimitConfig = {
  timestep0: bigint;
  timestep1: bigint;
  limit0: bigint;
  limit1: bigint;
  limitGlobal: bigint;
  flags: number;
};

export type BrokerLimitState = {
  lastUpdated0: bigint;
  lastUpdated1: bigint;
  netflow0: bigint;
  netflow1: bigint;
  netflowGlobal: bigint;
};

export const EMPTY_BROKER_LIMIT_CONFIG: BrokerLimitConfig = {
  timestep0: 0n,
  timestep1: 0n,
  limit0: 0n,
  limit1: 0n,
  limitGlobal: 0n,
  flags: 0,
};

export const EMPTY_BROKER_LIMIT_STATE: BrokerLimitState = {
  lastUpdated0: 0n,
  lastUpdated1: 0n,
  netflow0: 0n,
  netflow1: 0n,
  netflowGlobal: 0n,
};

/** `limitId = exchangeId XOR bytes32(uint160(token))`, lowercase, 66 chars.
 * The XOR is an involution, so the same id comes back from a checksummed or a
 * lowercased token address. */
export function brokerLimitId(exchangeId: string, token: string): string {
  const xored = BigInt(exchangeId) ^ BigInt(token);
  return `0x${xored.toString(16).padStart(LIMIT_ID_HEX_DIGITS, "0")}`;
}

/** Entity id for one (exchange, token leg) row. */
export function brokerTradingLimitRowId(
  chainId: number,
  exchangeId: string,
  token: string,
): string {
  return `${chainId}-${exchangeId.toLowerCase()}-${token.toLowerCase()}`;
}

export type EnabledWindows = { l0: boolean; l1: boolean; lg: boolean };

/** A window contributes only when its flag bit is set AND its limit is > 0.
 * A configured-but-zero limit would otherwise divide by zero. */
export function enabledWindows(config: BrokerLimitConfig): EnabledWindows {
  return {
    l0: (config.flags & LIMIT_FLAG_L0) !== 0 && config.limit0 > 0n,
    l1: (config.flags & LIMIT_FLAG_L1) !== 0 && config.limit1 > 0n,
    lg: (config.flags & LIMIT_FLAG_LG) !== 0 && config.limitGlobal > 0n,
  };
}

export function hasEnabledWindow(config: BrokerLimitConfig): boolean {
  const windows = enabledWindows(config);
  return windows.l0 || windows.l1 || windows.lg;
}

export type BrokerPressures = {
  p0: number;
  p1: number;
  pGlobal: number;
  worst: number;
};

function pressure(enabled: boolean, netflow: bigint, limit: bigint): number {
  if (!enabled || limit <= 0n) return 0;
  const abs = netflow < 0n ? -netflow : netflow;
  const exact = Number((abs * PRESSURE_SCALE) / limit) / Number(PRESSURE_SCALE);
  // Quantize to the 4dp the row serializes and the dashboard renders. Status
  // thresholds read the same number, so a value that rounds up across a
  // threshold cannot colour the bar amber while the badge still reads OK.
  return Math.round(exact * PRESSURE_DP) / PRESSURE_DP;
}

/** Pressure per window as |netflow| / limit. Disabled windows read 0, never
 * NaN or Infinity. */
export function computeBrokerPressures(
  config: BrokerLimitConfig,
  state: BrokerLimitState,
): BrokerPressures {
  const windows = enabledWindows(config);
  const p0 = pressure(windows.l0, state.netflow0, config.limit0);
  const p1 = pressure(windows.l1, state.netflow1, config.limit1);
  const pGlobal = pressure(windows.lg, state.netflowGlobal, config.limitGlobal);
  return { p0, p1, pGlobal, worst: Math.max(p0, p1, pGlobal) };
}

/** Same WARN/CRITICAL thresholds as the FPMM path. `N/A` until both halves of
 * the row are known and at least one window is enabled — never a false OK. */
export function computeBrokerLimitStatus(
  config: BrokerLimitConfig,
  state: BrokerLimitState,
  configKnown: boolean,
  stateKnown: boolean,
): string {
  if (!configKnown || !stateKnown) return "N/A";
  if (!hasEnabledWindow(config)) return "N/A";
  const { worst } = computeBrokerPressures(config, state);
  if (worst >= 1.0) return "CRITICAL";
  if (worst >= BROKER_LIMIT_HOT_PRESSURE) return "WARN";
  return "OK";
}

/** Mirrors `TradingLimits.reset()`: both window clocks restart, and a netflow
 * is zeroed only when its flag is UNSET. Enabled windows keep their netflow.
 * The gate is the flag bit alone, matching the contract — not `enabledWindows`,
 * which also requires a positive limit. */
export function resetBrokerState(
  state: BrokerLimitState | undefined,
  config: BrokerLimitConfig,
): BrokerLimitState {
  const previous = state ?? EMPTY_BROKER_LIMIT_STATE;
  return {
    lastUpdated0: 0n,
    lastUpdated1: 0n,
    netflow0: (config.flags & LIMIT_FLAG_L0) === 0 ? 0n : previous.netflow0,
    netflow1: (config.flags & LIMIT_FLAG_L1) === 0 ? 0n : previous.netflow1,
    netflowGlobal:
      (config.flags & LIMIT_FLAG_LG) === 0 ? 0n : previous.netflowGlobal,
  };
}

export function brokerLimitConfigFromRow(
  row: BrokerTradingLimit,
): BrokerLimitConfig {
  return {
    timestep0: row.timestep0,
    timestep1: row.timestep1,
    limit0: row.limit0,
    limit1: row.limit1,
    limitGlobal: row.limitGlobal,
    flags: row.flags,
  };
}

export function brokerLimitStateFromRow(
  row: BrokerTradingLimit,
): BrokerLimitState {
  return {
    lastUpdated0: row.lastUpdated0,
    lastUpdated1: row.lastUpdated1,
    netflow0: row.netflow0,
    netflow1: row.netflow1,
    netflowGlobal: row.netflowGlobal,
  };
}

function storedWorstPressure(row: BrokerTradingLimit): number {
  return Math.max(
    Number(row.limitPressure0),
    Number(row.limitPressure1),
    Number(row.limitPressureGlobal),
  );
}

/** Freshness gate for the at-block state read.
 *
 * Always false when the event's block is at or below the block the stored
 * state was pinned to: a second swap in the same block cannot move state the
 * read already covers, and re-reading would only spend an eth_call. */
export function shouldRefreshBrokerState(
  row: BrokerTradingLimit | undefined,
  blockNumber: bigint,
  blockTimestamp: bigint,
): boolean {
  if (!row) return true;
  if (blockNumber <= row.stateBlock) return false;
  if (!row.configKnown || !row.stateKnown) return true;
  if (blockTimestamp - row.stateTimestamp >= BROKER_LIMIT_REFRESH_SECONDS) {
    return true;
  }
  return storedWorstPressure(row) >= BROKER_LIMIT_HOT_PRESSURE;
}

export function buildBrokerTradingLimitRow(args: {
  chainId: number;
  exchangeId: string;
  exchangeProvider: string;
  poolId: string;
  token: string;
  config: BrokerLimitConfig;
  configKnown: boolean;
  state: BrokerLimitState;
  stateKnown: boolean;
  stateBlock: bigint;
  stateTimestamp: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): BrokerTradingLimit {
  const { p0, p1, pGlobal } = computeBrokerPressures(args.config, args.state);
  return {
    id: brokerTradingLimitRowId(args.chainId, args.exchangeId, args.token),
    chainId: args.chainId,
    exchangeId: args.exchangeId,
    exchangeProvider: args.exchangeProvider,
    limitId: brokerLimitId(args.exchangeId, args.token),
    poolId: args.poolId,
    token: args.token.toLowerCase(),
    configKnown: args.configKnown,
    flags: args.config.flags,
    timestep0: args.config.timestep0,
    timestep1: args.config.timestep1,
    limit0: args.config.limit0,
    limit1: args.config.limit1,
    limitGlobal: args.config.limitGlobal,
    stateKnown: args.stateKnown,
    netflow0: args.state.netflow0,
    netflow1: args.state.netflow1,
    netflowGlobal: args.state.netflowGlobal,
    lastUpdated0: args.state.lastUpdated0,
    lastUpdated1: args.state.lastUpdated1,
    stateBlock: args.stateBlock,
    stateTimestamp: args.stateTimestamp,
    limitPressure0: p0.toFixed(4),
    limitPressure1: p1.toFixed(4),
    limitPressureGlobal: pGlobal.toFixed(4),
    limitStatus: computeBrokerLimitStatus(
      args.config,
      args.state,
      args.configKnown,
      args.stateKnown,
    ),
    updatedAtBlock: args.blockNumber,
    updatedAtTimestamp: args.blockTimestamp,
  };
}

/** Worst-wins order. Index 0 is the floor, so an unranked value folds to
 * `N/A` rather than silently outranking a real status. */
const STATUS_BY_SEVERITY = ["N/A", "OK", "WARN", "CRITICAL"] as const;

function statusRank(status: string): number {
  const rank = STATUS_BY_SEVERITY.indexOf(
    status as (typeof STATUS_BY_SEVERITY)[number],
  );
  return rank < 0 ? 0 : rank;
}

export type PoolLimitFields = Pick<
  Pool,
  "limitStatus" | "limitPressure0" | "limitPressure1"
>;

const NO_POOL_LIMIT_FIELDS: PoolLimitFields = {
  limitStatus: "N/A",
  limitPressure0: "0.0000",
  limitPressure1: "0.0000",
};

/** Denormalize the wrapped exchange's rows onto the VirtualPool.
 * `limitPressure0/1` are PER-TOKEN slots (worst enabled window for `token0` /
 * `token1`), matching the FPMM path. Stays `N/A` until a leg has both its
 * config and an exact-block state read. */
export function foldPoolLimitFields(
  rows: readonly BrokerTradingLimit[],
  pool: Pick<Pool, "token0" | "token1">,
): PoolLimitFields {
  // Tokens mirror onto the VirtualPool from the exchange link, which can land
  // after the first Broker swap. Without both slots a real status would show
  // with two 0.00% pressures, so stay `N/A` until the tokens arrive.
  if (!pool.token0 || !pool.token1) return NO_POOL_LIMIT_FIELDS;
  const known = rows.filter((row) => row.configKnown && row.stateKnown);
  const rowFor = (token: string): BrokerTradingLimit | undefined =>
    known.find((row) => row.token.toLowerCase() === token.toLowerCase());
  // One leg's RPC read can succeed while the other fails. Folding a status from
  // the readable leg alone would publish OK while the unread leg already sits
  // at its cap, and the missing leg's slot would render a real-looking 0.00%.
  // Both legs must be known before any pool-level status is published.
  const row0 = rowFor(pool.token0);
  const row1 = rowFor(pool.token1);
  if (!row0 || !row1) return NO_POOL_LIMIT_FIELDS;

  const pressureFor = (row: BrokerTradingLimit): string =>
    storedWorstPressure(row).toFixed(4);

  const worstRank = Math.max(
    statusRank(row0.limitStatus),
    statusRank(row1.limitStatus),
  );

  return {
    limitStatus: STATUS_BY_SEVERITY[worstRank] ?? "N/A",
    limitPressure0: pressureFor(row0),
    limitPressure1: pressureFor(row1),
  };
}
