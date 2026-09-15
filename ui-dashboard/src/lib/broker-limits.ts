/**
 * Pure helpers for the v2 Broker trading limits a VirtualPool wraps.
 *
 * Broker limit and netflow values are WHOLE TOKEN UNITS (int48 on-chain), so
 * they never pass through `formatWei(..., TRADING_LIMITS_INTERNAL_DECIMALS)` —
 * that scale belongs to the FPMM `TradingLimit` entity only.
 *
 * A window contributes to the UI only when its flag bit is set AND its limit is
 * above zero, so a disabled window renders nothing instead of a 0% bar.
 */

import { sortedCopy } from "@/lib/immutable-sort";
import type { BrokerTradingLimitRow } from "@/lib/types";

/** `TradingLimits.Config.flags` bits. */
export const LIMIT_FLAG_L0 = 1;
export const LIMIT_FLAG_L1 = 2;
export const LIMIT_FLAG_LG = 4;

/** State older than this reads as stale in the panel footer. The indexer
 *  re-reads Broker state at most every 5 minutes per leg, so 30 minutes means
 *  the exchange simply has not traded — worth flagging, not an error. */
export const BROKER_STATE_STALE_SECONDS = 1_800;

type BrokerLimitWindowKey = "global" | "l0" | "l1";

export type BrokerLimitWindow = {
  key: BrokerLimitWindowKey;
  label: string;
  hint: string;
  /** Indexer-computed 4dp ratio of |netflow| to the window limit. */
  pressure: string;
  /** Signed whole token units. */
  netflow: string;
  /** Whole token units. */
  limit: string;
};

export type BrokerLimitsState = {
  rows: BrokerTradingLimitRow[];
  isLoading: boolean;
  hasError: boolean;
};

// A reconfigure zeroes a window's net flow only when it DISABLES that window,
// so the global figure keeps accumulating across configuration changes that
// leave LG enabled. Do not describe it as "since the limit was configured".
const GLOBAL_HINT =
  "Net flow accumulated while the global window has been enabled; no " +
  "time-based reset, and a reconfigure that keeps it enabled does not zero it.";
const ROLLING_HINT =
  "Net flow inside the rolling window; the window resets on its own timestep.";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

/** Human period for a config timestep, e.g. "5-minute", "Daily", "12-hour".
 *  The Broker configures these per exchange — they are not the fixed 5m/24h
 *  pair the FPMM TradingLimitsV2 contract hardcodes. */
export function windowLabel(timestepSeconds: string): string {
  const seconds = Number(timestepSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "Rolling";
  if (seconds % SECONDS_PER_DAY === 0) {
    const days = seconds / SECONDS_PER_DAY;
    return days === 1 ? "Daily" : `${days}-day`;
  }
  if (seconds % SECONDS_PER_HOUR === 0) {
    const hours = seconds / SECONDS_PER_HOUR;
    return hours === 1 ? "Hourly" : `${hours}-hour`;
  }
  if (seconds % SECONDS_PER_MINUTE === 0) {
    return `${seconds / SECONDS_PER_MINUTE}-minute`;
  }
  return `${seconds}-second`;
}

function isPositiveAmount(value: string): boolean {
  try {
    return BigInt(value) > BigInt(0);
  } catch {
    return false;
  }
}

/** Enabled windows for one token leg, global first. Empty when the config has
 *  not been read yet — the caller shows the degraded note instead of bars. */
export function enabledWindows(
  row: BrokerTradingLimitRow,
): BrokerLimitWindow[] {
  if (!row.configKnown) return [];
  const windows: BrokerLimitWindow[] = [];
  if ((row.flags & LIMIT_FLAG_LG) !== 0 && isPositiveAmount(row.limitGlobal)) {
    windows.push({
      key: "global",
      label: "Global limit (LG)",
      hint: GLOBAL_HINT,
      pressure: row.limitPressureGlobal,
      netflow: row.netflowGlobal,
      limit: row.limitGlobal,
    });
  }
  if ((row.flags & LIMIT_FLAG_L0) !== 0 && isPositiveAmount(row.limit0)) {
    windows.push({
      key: "l0",
      label: `${windowLabel(row.timestep0)} limit (L0)`,
      hint: ROLLING_HINT,
      pressure: row.limitPressure0,
      netflow: row.netflow0,
      limit: row.limit0,
    });
  }
  if ((row.flags & LIMIT_FLAG_L1) !== 0 && isPositiveAmount(row.limit1)) {
    windows.push({
      key: "l1",
      label: `${windowLabel(row.timestep1)} limit (L1)`,
      hint: ROLLING_HINT,
      pressure: row.limitPressure1,
      netflow: row.netflow1,
      limit: row.limit1,
    });
  }
  return windows;
}

/** Whole-unit amount with thousands separators, e.g. "1,139". int48 values fit
 *  Number exactly, so no BigInt formatting is needed. */
export function formatWholeUnits(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Rows in pool-token order (the token0 leg first) so the panel reads in the
 *  same order as the pool title whatever order Hasura returns. A leg that
 *  matches neither token sorts last rather than disappearing. */
export function orderRowsByPoolTokens(
  rows: BrokerTradingLimitRow[],
  token0: string | null,
  token1: string | null,
): BrokerTradingLimitRow[] {
  const order = [token0, token1].map((token) => (token ?? "").toLowerCase());
  const rank = (row: BrokerTradingLimitRow) => {
    const index = order.indexOf(row.token.toLowerCase());
    return index === -1 ? order.length : index;
  };
  return sortedCopy(rows, (a, b) => rank(a) - rank(b));
}

export type BrokerLegCoverage = {
  /** Both pool token legs have a row whose config and state reads landed. */
  complete: boolean;
  /** Pool tokens still waiting on one of those reads. Empty when the pool has
   *  not mirrored its own token legs yet, because there is nothing to name. */
  pending: string[];
};

/** Which of a pool's two token legs the Broker has not fully read. Mirrors
 *  `foldPoolLimitFields` in the indexer: one leg's RPC read can succeed while
 *  the other fails, and the readable leg must not speak for the pool — the
 *  unread leg may already sit at its cap. */
export function brokerLegCoverage(
  rows: BrokerTradingLimitRow[],
  token0: string | null,
  token1: string | null,
): BrokerLegCoverage {
  if (!token0 || !token1) return { complete: false, pending: [] };
  const pending = [token0, token1].filter((token) => {
    const row = rows.find(
      (candidate) => candidate.token.toLowerCase() === token.toLowerCase(),
    );
    return !row?.configKnown || !row.stateKnown;
  });
  return { complete: pending.length === 0, pending };
}

const STATUS_RANK: Record<string, number> = {
  "N/A": 0,
  OK: 1,
  WARN: 2,
  CRITICAL: 3,
};

/** Worst indexed status across a pool's legs. "N/A" until both legs are fully
 *  read, so a partial read never reports OK, and "N/A" for any status the
 *  indexer has not written yet — never a fabricated OK. WARN and CRITICAL
 *  still dominate once both legs are known. */
export function worstRowStatus(
  rows: BrokerTradingLimitRow[],
  token0: string | null,
  token1: string | null,
): string {
  if (!brokerLegCoverage(rows, token0, token1).complete) return "N/A";
  let worst = "N/A";
  let worstRank = 0;
  for (const row of rows) {
    const rank = STATUS_RANK[row.limitStatus] ?? 0;
    if (rank > worstRank) {
      worstRank = rank;
      worst = row.limitStatus;
    }
  }
  return worst;
}

/** The leg under the most pressure, for the single-tile header summary. Rows
 *  with no enabled window are skipped so a configured leg always wins. */
export function worstBrokerRow(
  rows: BrokerTradingLimitRow[],
): BrokerTradingLimitRow | null {
  let worst: BrokerTradingLimitRow | null = null;
  let worstPressure = -1;
  for (const row of rows) {
    // A config-known row whose state is still unread carries zero pressure.
    // Picking it would pin the tile to a row the consumers then render as "—",
    // hiding a later row that has a real reading at the same pressure.
    if (!row.stateKnown) continue;
    const windows = enabledWindows(row);
    if (windows.length === 0) continue;
    const pressure = Math.max(
      ...windows.map((window) => Number(window.pressure) || 0),
    );
    if (pressure > worstPressure) {
      worstPressure = pressure;
      worst = row;
    }
  }
  return worst;
}
