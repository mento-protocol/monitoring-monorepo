import {
  DEVIATION_CRITICAL_RATIO,
  DEVIATION_TOLERANCE_RATIO,
} from "@mento-protocol/monitoring-config/thresholds";
import { LEGACY_OPEN_BREACH_ENTRY_THRESHOLD } from "./config.js";
import type { PoolRow } from "./types.js";

export const DEVIATION_WARNING_PENDING_SECONDS = 900;
export const DEVIATION_CRITICAL_FIRING_SECONDS = 3_660;
export const DEVIATION_TRANSITION_ACTIVE_SECONDS = 180;

export type DeviationAlertState =
  | "ok"
  | "warning"
  | "critical"
  | "ratio_missing_warning"
  | "ratio_missing_critical"
  | "fx_paused"
  | "unknown";

export type DeviationTransitionReason =
  | "breach_started"
  | "recovered"
  | "escalated_to_critical"
  | "deescalated_to_warning"
  | "ratio_data_missing"
  | "ratio_data_restored"
  | "fx_weekend_suppressed"
  | "fx_weekend_reopened"
  | "state_changed";

export type DeviationAlertTransition = {
  from: DeviationAlertState;
  to: DeviationAlertState;
  reason: DeviationTransitionReason;
  breachStartedAt: number;
  endedAt: number;
  durationSeconds: number;
  breachStartedAtLabel: string;
  endedAtLabel: string;
  durationLabel: string;
};

type StateSnapshot = {
  state: DeviationAlertState;
  breachStartedAt: number | null;
  enteredAt: number;
};

const previousStates = new Map<string, StateSnapshot>();
const recentTransitions = new Map<string, DeviationAlertTransition>();

// Mirrors terraform/alerts/main.tf's `usd_pegged_symbols_regex_part`.
// Keep this list in sync with that HCL local until the FX classifier moves
// into shared-config.
const USD_PEGGED_SYMBOLS = new Set([
  "USDm",
  "USDC",
  "USDT",
  "USDT0",
  "USD₮",
  "AUSD",
  "cUSD",
  "axlUSDC",
]);

function fp(value: string): number {
  return parseFloat(value);
}

function openBreachPeakRatio(pool: PoolRow): number {
  const openBreachPeak = fp(pool.currentOpenBreachPeak);
  const openBreachEntryThreshold =
    pool.currentOpenBreachEntryThreshold > 0
      ? pool.currentOpenBreachEntryThreshold
      : LEGACY_OPEN_BREACH_ENTRY_THRESHOLD;
  return openBreachPeak > 0 ? openBreachPeak / openBreachEntryThreshold : 0;
}

function isFxPair(pair: string): boolean {
  const [token0, token1, extra] = pair.split("/");
  if (!token0 || !token1 || extra) return false;
  return !(USD_PEGGED_SYMBOLS.has(token0) && USD_PEGGED_SYMBOLS.has(token1));
}

function isFxWeekend(nowSeconds: number): boolean {
  const date = new Date(nowSeconds * 1000);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  return day === 6 || (day === 0 && hour < 23) || (day === 5 && hour >= 21);
}

function formatUtcTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(
    date.getUTCDate(),
  )} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function formatWholeMinuteDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export function classifyDeviationAlertState(
  pool: PoolRow,
  pair: string,
  nowSeconds: number,
): Pick<StateSnapshot, "state" | "breachStartedAt"> {
  const breachStartedAt = Number(pool.deviationBreachStartedAt);
  if (!Number.isFinite(breachStartedAt)) {
    return { state: "unknown", breachStartedAt: null };
  }

  const breachActive = breachStartedAt > 0;
  const ratio = fp(pool.lastDeviationRatio);
  const ratioPresent = Number.isFinite(ratio) && ratio >= 0;
  const ratioAboveTolerance = ratioPresent && ratio > DEVIATION_TOLERANCE_RATIO;
  const hasOpenDeviation = breachActive || ratioAboveTolerance;

  if (hasOpenDeviation && isFxPair(pair) && isFxWeekend(nowSeconds)) {
    return {
      state: "fx_paused",
      breachStartedAt: breachActive ? breachStartedAt : null,
    };
  }

  if (!ratioPresent) {
    if (!breachActive) return { state: "ok", breachStartedAt: null };
    const ageSeconds = nowSeconds - breachStartedAt;
    return {
      state:
        ageSeconds > DEVIATION_CRITICAL_FIRING_SECONDS
          ? "ratio_missing_critical"
          : "ratio_missing_warning",
      breachStartedAt,
    };
  }

  if (!ratioAboveTolerance) {
    return { state: "ok", breachStartedAt: null };
  }

  const criticalMagnitude =
    ratio > DEVIATION_CRITICAL_RATIO ||
    openBreachPeakRatio(pool) > DEVIATION_CRITICAL_RATIO;
  const criticalAge =
    breachActive &&
    nowSeconds - breachStartedAt > DEVIATION_CRITICAL_FIRING_SECONDS;

  return {
    state: criticalMagnitude && criticalAge ? "critical" : "warning",
    breachStartedAt: breachActive ? breachStartedAt : null,
  };
}

function transitionReason(
  from: DeviationAlertState,
  to: DeviationAlertState,
): DeviationTransitionReason {
  if (to === "ok") return "recovered";
  if (to === "fx_paused") return "fx_weekend_suppressed";
  if (from === "fx_paused") return "fx_weekend_reopened";
  if (
    (from === "warning" || from === "ratio_missing_warning") &&
    (to === "critical" || to === "ratio_missing_critical")
  ) {
    return "escalated_to_critical";
  }
  if (
    (from === "critical" || from === "ratio_missing_critical") &&
    (to === "warning" || to === "ratio_missing_warning")
  ) {
    return "deescalated_to_warning";
  }
  if (to.startsWith("ratio_missing") && !from.startsWith("ratio_missing")) {
    return "ratio_data_missing";
  }
  if (from.startsWith("ratio_missing") && !to.startsWith("ratio_missing")) {
    return "ratio_data_restored";
  }
  if (from === "ok") return "breach_started";
  return "state_changed";
}

function alertCouldHaveFired(
  snapshot: StateSnapshot,
  nowSeconds: number,
): boolean {
  const anchor = snapshot.breachStartedAt ?? snapshot.enteredAt;
  const ageSeconds = nowSeconds - anchor;
  if (
    snapshot.state === "warning" ||
    snapshot.state === "ratio_missing_warning"
  ) {
    return ageSeconds >= DEVIATION_WARNING_PENDING_SECONDS;
  }
  if (
    snapshot.state === "critical" ||
    snapshot.state === "ratio_missing_critical"
  ) {
    return ageSeconds > DEVIATION_CRITICAL_FIRING_SECONDS;
  }
  return false;
}

function shouldRecordTransition(
  previous: StateSnapshot,
  current: StateSnapshot,
  nowSeconds: number,
): boolean {
  const reason = transitionReason(previous.state, current.state);
  if (
    reason === "breach_started" ||
    reason === "fx_weekend_reopened" ||
    reason === "state_changed"
  ) {
    return false;
  }
  return (
    alertCouldHaveFired(previous, nowSeconds) ||
    alertCouldHaveFired(current, nowSeconds)
  );
}

function transitionKey(poolId: string, transition: DeviationAlertTransition) {
  return [
    poolId,
    transition.from,
    transition.to,
    transition.reason,
    transition.endedAt,
  ].join(":");
}

function pruneRecentTransitions(nowSeconds: number): void {
  for (const [key, transition] of recentTransitions) {
    if (nowSeconds - transition.endedAt > DEVIATION_TRANSITION_ACTIVE_SECONDS) {
      recentTransitions.delete(key);
    }
  }
}

function buildTransition(
  previous: StateSnapshot,
  current: StateSnapshot,
  nowSeconds: number,
): DeviationAlertTransition {
  const breachStartedAt =
    previous.breachStartedAt ?? current.breachStartedAt ?? previous.enteredAt;
  const durationSeconds = Math.max(0, nowSeconds - breachStartedAt);
  return {
    from: previous.state,
    to: current.state,
    reason: transitionReason(previous.state, current.state),
    breachStartedAt,
    endedAt: nowSeconds,
    durationSeconds,
    breachStartedAtLabel: formatUtcTimestamp(breachStartedAt),
    endedAtLabel: formatUtcTimestamp(nowSeconds),
    durationLabel: formatWholeMinuteDuration(durationSeconds),
  };
}

export function observeDeviationAlertState(
  pool: PoolRow,
  pair: string,
  nowSeconds: number,
): {
  state: DeviationAlertState;
  newTransitions: DeviationAlertTransition[];
  activeTransitions: DeviationAlertTransition[];
} {
  pruneRecentTransitions(nowSeconds);

  const currentState = classifyDeviationAlertState(pool, pair, nowSeconds);
  const previous = previousStates.get(pool.id);
  const enteredAt =
    previous && previous.state === currentState.state
      ? previous.enteredAt
      : nowSeconds;
  const current: StateSnapshot = {
    ...currentState,
    enteredAt,
  };

  const newTransitions: DeviationAlertTransition[] = [];
  if (
    previous &&
    previous.state !== current.state &&
    shouldRecordTransition(previous, current, nowSeconds)
  ) {
    const transition = buildTransition(previous, current, nowSeconds);
    recentTransitions.set(transitionKey(pool.id, transition), transition);
    newTransitions.push(transition);
  }

  previousStates.set(pool.id, current);

  const activeTransitions = Array.from(recentTransitions.entries())
    .filter(([key, transition]) => {
      return (
        key.startsWith(`${pool.id}:`) &&
        nowSeconds - transition.endedAt <= DEVIATION_TRANSITION_ACTIVE_SECONDS
      );
    })
    .map(([, transition]) => transition);

  return {
    state: current.state,
    newTransitions,
    activeTransitions,
  };
}

export function pruneDeviationAlertStates(activePoolIds: Set<string>): void {
  for (const poolId of previousStates.keys()) {
    if (!activePoolIds.has(poolId)) previousStates.delete(poolId);
  }
}

export function resetDeviationAlertStateForTests(): void {
  previousStates.clear();
  recentTransitions.clear();
}
